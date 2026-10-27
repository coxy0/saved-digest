// Plain line output (no \r redraws) so progress reads well in a terminal and inside Claude Code alike.
export const step = (title) => console.log(`\n› ${title}`);
export const info = (msg) => console.log(`  ${msg}`);
export const duration = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)} min`);
export const about = (seconds) => `about ${Math.max(1, Math.round(seconds / 60))} min`;
// every 10th item plus the first and last, so 100 items stay readable
export const progress = (label, i, n) => { if (i === 1 || i === n || i % 10 === 0) info(`${label} ${i}/${n}`); };
