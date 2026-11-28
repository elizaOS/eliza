# MCP schema worker lifecycle

An attacker-controlled MCP tool `inputSchema` is compiled and evaluated inside a bounded, isolated worker. Fixed JSON Schema dialect warm-up completes before untrusted input is delivered, and every timeout, evaluation or failure settles before returning.

## Story: Isolate untrusted MCP schema compilation and validation

> As the owner, I want each untrusted MCP tool schema validation to warm up before receiving input and always settle with a definite result before returning.

### Untrusted schema input is delivered only after warm-up and always settles to a definite result

A fresh worker starts in `WorkerStartup` with `warmed = false`, `inputDelivered = false`, and `result = WorkerPending`. `readyWorker` runs only from `WorkerStartup` and marks `warmed = true` in `WorkerReady`; `submitSchema` runs only from `WorkerReady` when warmed and marks `inputDelivered = true` in `WorkerEvaluating`. `evaluateSchema` runs only from `WorkerEvaluating` with delivered input and enters `WorkerTerminating` with `WorkerValid` or `WorkerInvalid`. `timeoutWorker` runs from `WorkerStartup` or `WorkerEvaluating` to set `WorkerTimeout` in `WorkerTerminating`; `failWorker` runs from `WorkerStartup`, `WorkerReady`, or `WorkerEvaluating` to set `WorkerError` in `WorkerTerminating`. `settleWorker` runs only from `WorkerTerminating` to enter `WorkerReturned`. Across every state: delivered input implies warm-up, `WorkerEvaluating` and `WorkerValid` imply delivered input, `WorkerStartup` has no delivered input, and both `WorkerTerminating` and `WorkerReturned` carry a non-pending result.

```quint
type SchemaWorkerPhase = WorkerStartup | WorkerReady | WorkerEvaluating | WorkerTerminating | WorkerReturned
type SchemaWorkerResult = WorkerPending | WorkerValid | WorkerInvalid | WorkerTimeout | WorkerError
type SchemaWorkerState = { phase: SchemaWorkerPhase, warmed: bool, inputDelivered: bool, result: SchemaWorkerResult }
pure val initial: SchemaWorkerState = { phase: WorkerStartup, warmed: false, inputDelivered: false, result: WorkerPending }
pure def canReadyWorker(s: SchemaWorkerState): bool = s.phase == WorkerStartup
pure def readyWorker(s: SchemaWorkerState): SchemaWorkerState = { ...s, phase: WorkerReady, warmed: true }
pure def canSubmitSchema(s: SchemaWorkerState): bool = s.phase == WorkerReady and s.warmed
pure def submitSchema(s: SchemaWorkerState): SchemaWorkerState = { ...s, phase: WorkerEvaluating, inputDelivered: true }
pure def canEvaluateSchema(s: SchemaWorkerState): bool = s.phase == WorkerEvaluating and s.inputDelivered
pure def evaluateSchema(s: SchemaWorkerState, valid: bool): SchemaWorkerState =
  { ...s, phase: WorkerTerminating, result: if (valid) WorkerValid else WorkerInvalid }
pure def canTimeoutWorker(s: SchemaWorkerState): bool = s.phase == WorkerStartup or s.phase == WorkerEvaluating
pure def timeoutWorker(s: SchemaWorkerState): SchemaWorkerState = { ...s, phase: WorkerTerminating, result: WorkerTimeout }
pure def canFailWorker(s: SchemaWorkerState): bool =
  s.phase == WorkerStartup or s.phase == WorkerReady or s.phase == WorkerEvaluating
pure def failWorker(s: SchemaWorkerState): SchemaWorkerState = { ...s, phase: WorkerTerminating, result: WorkerError }
pure def canSettleWorker(s: SchemaWorkerState): bool = s.phase == WorkerTerminating
pure def settleWorker(s: SchemaWorkerState): SchemaWorkerState = { ...s, phase: WorkerReturned }
pure def alwaysInputDeliveredNeedsWarmup(s: SchemaWorkerState): bool = s.inputDelivered implies s.warmed
pure def alwaysEvaluatingHasInput(s: SchemaWorkerState): bool = s.phase == WorkerEvaluating implies s.inputDelivered
pure def alwaysValidResultHadInput(s: SchemaWorkerState): bool = s.result == WorkerValid implies s.inputDelivered
pure def alwaysTerminatingHasResult(s: SchemaWorkerState): bool = s.phase == WorkerTerminating implies s.result != WorkerPending
pure def alwaysReturnedHasResult(s: SchemaWorkerState): bool = s.phase == WorkerReturned implies s.result != WorkerPending
pure def alwaysStartupHasNoInput(s: SchemaWorkerState): bool = s.phase == WorkerStartup implies not(s.inputDelivered)
pure def sometimesWorkerValidates(s: SchemaWorkerState): bool = s.phase == WorkerReturned and s.result == WorkerValid
pure def sometimesWorkerTimesOutBeforeInput(s: SchemaWorkerState): bool =
  s.phase == WorkerReturned and s.result == WorkerTimeout and not(s.inputDelivered)
pure val eval_witness_sometimesWorkerValidates = ("readyWorker", "submitSchema", ("evaluateSchema", true), "settleWorker")
pure val eval_witness_sometimesWorkerTimesOutBeforeInput = ("timeoutWorker", "settleWorker")
```
