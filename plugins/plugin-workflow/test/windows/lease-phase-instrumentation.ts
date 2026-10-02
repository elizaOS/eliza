/** Test-only instrumentation of committed, trusted generated source. Never deployed. */
export function instrumentLeasePrelude(prelude: string, resource: string): string {
  const phases = [
    'bootstrap',
    'source-read',
    'hash-verified',
    'utility-resolve-start',
    'utility-resolved',
    'compile-start',
    'compiled',
    'request-read',
    'reserved',
    'ready',
  ];
  const marker = (phase: string) =>
    `[Console]::Error.WriteLine('[lease-probe:${phase}]');[Console]::Error.Flush();`;
  const replaceOnce = (text: string, needle: string, replacement: string) => {
    if (text.split(needle).length !== 2) throw Error('Diagnostic source boundary changed');
    return text.replace(needle, replacement);
  };
  const match = prelude.match(/var [A-Za-z_$][\w$]*=(`Add-Type[\s\S]*?`);/);
  if (!match) throw Error('Committed helper resource boundary missing');
  // Evaluate only the isolated literal from this repository's trusted generated source.
  // Equality rejects drift or incorrectly escaped source before instrumenting it.
  if (Function(`return ${match[1]}`)() !== resource) throw Error('Committed helper bytes differ');
  let observed =
    marker('utility-resolve-start') +
    '\nGet-Command Add-Type -ErrorAction Stop | Out-Null\n' +
    marker('utility-resolved') +
    '\n' +
    marker('compile-start') +
    '\n' +
    resource;
  observed = replaceOnce(observed, "\n'@\n", "\n'@\n" + marker('compiled') + '\n');
  observed = replaceOnce(
    observed,
    '$request=$inputLine|ConvertFrom-Json',
    '$request=$inputLine|ConvertFrom-Json\n' + marker('request-read')
  );
  observed = replaceOnce(
    observed,
    '$stop=[Threading.CancellationTokenSource]::new()',
    marker('reserved') + '\n$stop=[Threading.CancellationTokenSource]::new()'
  );
  observed = replaceOnce(
    observed,
    'Emit @{ready=$true;generation=$generation}',
    marker('ready') + '\n    Emit @{ready=$true;generation=$generation}'
  );
  let output = replaceOnce(prelude, match[1], JSON.stringify(observed));
  output = replaceOnce(
    output,
    "$ErrorActionPreference='Stop';$line=[Console]::ReadLine();",
    "$ErrorActionPreference='Stop';" +
      marker('bootstrap') +
      '$line=[Console]::ReadLine();' +
      marker('source-read')
  );
  output = replaceOnce(
    output,
    ';& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes)))',
    ';' +
      marker('hash-verified') +
      '& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes)))'
  );
  // Retain original stderr draining and bounds; forward only our static phase enum.
  // Scan the bounded accumulator so split pipe chunks cannot lose a marker.
  const drain = 'if(w.length<65536)w+=o.slice(0,65536-w.length)';
  output = replaceOnce(
    output,
    drain,
    drain +
      `;for(const phase of ${JSON.stringify(phases)})if(w.includes('[lease-probe:'+phase+']'))globalThis.__leaseProbePhase?.(phase)`
  );
  // The original helper hashes the instrumented resource before dispatch, and the
  // PowerShell bootstrap still verifies that hash. No admission/deadline code changes.
  return output;
}
