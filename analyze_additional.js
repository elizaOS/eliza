const bugs = [
  {
    id: 19170,
    title: "post-merge review: #18996 consolidate Eliza Cloud into eliza.app is the causal commit for four develop CI failures",
    scope: "CI diagnosis - identify and route 4 failures from a single PR",
    platformSpecific: false,
    credentialDependent: false,
    estimatedHours: 2.5,
    impact: "High - blocks develop health",
    complexity: "High - multi-path diagnosis"
  },
  {
    id: 19168,
    title: "fix(cloud): completed agent delete destroys the pre-delete backup it just took (ON DELETE CASCADE)",
    scope: "Database schema - remove CASCADE constraint",
    platformSpecific: false,
    credentialDependent: false,
    estimatedHours: 0.5,
    impact: "High - data loss bug",
    complexity: "Low - single constraint fix"
  },
  {
    id: 18374,
    title: "fix(ui): make structural stop-voice tear down realtime Cartesia",
    scope: "Voice cleanup - lifecycle management",
    platformSpecific: false,
    credentialDependent: false,
    estimatedHours: 1,
    impact: "Medium - resource cleanup",
    complexity: "Medium - realtime connection teardown"
  }
];

const filtered = bugs.filter(b => b.estimatedHours < 2);

console.log("Additional candidates (< 2h):\n");
filtered.forEach(bug => {
  console.log(`#${bug.id}: ${bug.title}`);
  console.log(`  Est: ${bug.estimatedHours}h | Impact: ${bug.impact}\n`);
});
