onmessage = function (event) {
  var job = event.data && event.data.job;
  var cap = Math.min(50, Math.max(25, Number(event.data && event.data.cap) || 25));
  var series = Array.isArray(job && job.series) ? job.series : [];
  var index = 1;
  var cash = 0;
  var steps = 0;
  var params = (job && job.params) || {};

  function slice() {
    var start = Date.now();
    var budget = Math.max(8, Math.round(200 * (cap / 100)));
    while (index < series.length && Date.now() - start < budget) {
      var prev = Number(series[index - 1]);
      var next = Number(series[index]);
      index += 1;
      if (!Number.isFinite(prev) || !Number.isFinite(next) || prev === 0) continue;
      var stopPct = Number(params.stopPct);
      var takePct = Number(params.takePct);
      var size = Number(params.size);
      if (!Number.isFinite(stopPct)) stopPct = 15;
      if (!Number.isFinite(takePct)) takePct = 30;
      if (!Number.isFinite(size)) size = 0.05;
      var move = (next - prev) / prev;
      var gain = move > takePct / 100 ? takePct / 100 : move;
      var result = gain < -(stopPct / 100) ? -(stopPct / 100) : gain;
      cash += result * size;
      steps += 1;
    }
    if (index < series.length) {
      setTimeout(slice, 200);
      return;
    }
    postMessage({
      jobId: String(job && job.id || ""),
      kind: String(job && job.kind || "paper"),
      cash: Math.round(cash * 10000) / 10000,
      n: steps,
      engine: "cpu",
      simulated: true
    });
  }

  slice();
};
