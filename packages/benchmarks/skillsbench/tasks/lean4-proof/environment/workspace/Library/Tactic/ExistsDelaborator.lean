/- Copyright (c) Kyle Miller, 2023.  All rights reserved. -/
import Mathlib.Lean.Expr.Basic

open Lean in
/-- Set all the binder infos to `default` in a chain of `Exists`s. -/
partial def fixExists (e : Expr) : MetaM (Bool × Expr) := do
  let (`Exists, #[α, .lam x ty body bi]) := e.getAppFnArgs | return (false, e)
  let (changed, body) ← fixExists body
  let changed := changed || bi != .default
  return (changed, mkAppN e.getAppFn #[α, .lam x ty body .default])

open Lean Lean.PrettyPrinter.Delaborator in
@[delab app.Exists]
def withFixedExists : Delab := do
  let (changed, e) ← fixExists (← SubExpr.getExpr)
  unless changed do failure
  withTheReader SubExpr (fun cfg => { cfg with expr := e}) delab
