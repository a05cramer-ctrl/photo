// On-chain race results for the last hours: the first $PHOTO buy (>= MIN_SOL) at or after each hh:00:00 UTC.
// Env: HELIUS_API_KEY. CA / MIN_SOL from env or the deployed config.js. Cached 60 s at the edge.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
async function cfg(req) {
  let ca = process.env.CA || '', min = +process.env.MIN_SOL || 0;
  if (!ca || !min) {
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const t = await (await fetch(`https://${host}/config.js`)).text();
      ca = ca || (t.match(/\bCA\s*:\s*["']([^"']*)["']/) || [])[1] || '';
      min = min || +((t.match(/MIN_SOL\s*:\s*([0-9.]+)/) || [])[1] || 0.05);
    } catch (e) {}
  }
  return { ca: ca.trim(), min: min || 0.05 };
}
export default async function handler(req, res) {
  const key = process.env.HELIUS_API_KEY;
  const { ca, min } = await cfg(req);
  if (!B58.test(ca)) return res.status(204).end();
  if (!key) return res.status(503).json({ error: 'HELIUS_API_KEY not set' });
  const rpc = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const call = (method, params) => fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.json()).then(j => j.result);
  try {
    const now = Math.floor(Date.now() / 1000);
    const hours = []; for (let k = 0; k < 6; k++) hours.push(Math.floor(now / 3600) * 3600 - k * 3600);
    const oldest = hours[hours.length - 1];
    // walk signatures back until we pass the oldest hour mark
    let sigs = [], before;
    for (let page = 0; page < 8; page++) {
      const batch = await call('getSignaturesForAddress', [ca, { limit: 1000, before }]);
      if (!batch || !batch.length) break;
      sigs.push(...batch.filter(s => !s.err));
      before = batch[batch.length - 1].signature;
      if ((batch[batch.length - 1].blockTime || 0) < oldest) break;
    }
    sigs.sort((a, b) => a.slot - b.slot);
    const out = [];
    for (const H of hours) {
      const cand = sigs.filter(s => s.blockTime >= H && s.blockTime < H + 3600).slice(0, 40);
      if (!cand.length) continue;
      const parsed = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions: cand.map(c => c.signature) }) }).then(r => r.json());
      const bySig = new Map((Array.isArray(parsed) ? parsed : []).map(t => [t.signature, t]));
      for (const c of cand) {
        const t = bySig.get(c.signature); if (!t || t.transactionError) continue;
        const buyer = t.feePayer;
        const got = (t.tokenTransfers || []).some(x => x.mint === ca && x.toUserAccount === buyer && +x.tokenAmount > 0);
        const sol = (t.nativeTransfers || []).filter(x => x.fromUserAccount === buyer).reduce((s, x) => s + x.amount, 0) / 1e9;
        if (got && sol >= min) {
          const d = new Date(H * 1000);
          out.push({ hour: String(d.getUTCHours()).padStart(2, '0') + ':00', H, wallet: buyer, sol: +sol.toFixed(4), slot: c.slot, blockTime: c.blockTime, sig: c.signature });
          break;
        }
      }
    }
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ ca, min, hours: out });
  } catch (e) {
    res.status(502).json({ error: 'chain read failed' });
  }
}
