(function (root) {
  function simulate(job) {
    var series = Array.isArray(job && job.series) ? job.series : [];
    var params = (job && job.params) || {};
    var stopPct = Number(params.stopPct);
    var takePct = Number(params.takePct);
    var size = Number(params.size);
    if (!Number.isFinite(stopPct) || stopPct < 5 || stopPct > 30) stopPct = 15;
    if (!Number.isFinite(takePct) || takePct < 10 || takePct > 50) takePct = 30;
    if (!Number.isFinite(size) || size < 0.01 || size > 0.5) size = 0.05;
    var cash = 0;
    var steps = 0;
    for (var i = 1; i < series.length; i += 1) {
      var prev = Number(series[i - 1]);
      var next = Number(series[i]);
      if (!Number.isFinite(prev) || !Number.isFinite(next) || prev === 0) continue;
      var move = (next - prev) / prev;
      var gain = move > takePct / 100 ? takePct / 100 : move;
      var result = gain < -(stopPct / 100) ? -(stopPct / 100) : gain;
      cash += result * size;
      steps += 1;
    }
    return {
      jobId: String(job && job.id || ""),
      cash: Math.round(cash * 10000) / 10000,
      n: steps,
      simulated: true
    };
  }

  function sameResult(left, right) {
    return !!left && !!right && left.jobId === right.jobId && left.cash === right.cash && left.n === right.n;
  }

  root.ValhallaHive = { simulate: simulate, sameResult: sameResult };
})(typeof globalThis !== "undefined" ? globalThis : this);
