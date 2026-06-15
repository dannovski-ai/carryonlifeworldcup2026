const KEY = process.env.FOOTBALL_API_KEY || process.argv[2];
if (!KEY) { console.log('Usage: node check-api.js YOUR_API_KEY'); process.exit(1); }

fetch('https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED', {
  headers: { 'X-Auth-Token': KEY }
})
.then(r => r.json())
.then(data => {
  if (data.error) { console.log('API error:', data.error, data.message); return; }
  const matches = data.matches || [];
  console.log(`\n${matches.length} finished matches:\n`);
  matches.forEach(m => {
    const ft = m.score?.fullTime;
    console.log(`${m.homeTeam.name} ${ft?.home ?? '?'}–${ft?.away ?? '?'} ${m.awayTeam.name}`);
  });
})
.catch(e => console.log('Error:', e.message));
