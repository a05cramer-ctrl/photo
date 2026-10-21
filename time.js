// Server clock for the race countdown (visitors' own clocks drift).
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ now: Date.now() });
}
