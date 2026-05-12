/- Copyright (c) Joseph Rotella, 2023.  All rights reserved.
Authors: Joseph Rotella, Ryan Edmonds -/
import Std.Data.List.Basic
import Lean

open Lean Widget

inductive BExpr
| const : Bool → BExpr
| var : String → BExpr
| and : BExpr → BExpr → BExpr
| or : BExpr → BExpr → BExpr
| implies : BExpr → BExpr → BExpr
| not : BExpr → BExpr
| iff : BExpr → BExpr → BExpr
deriving Repr, DecidableEq, Inhabited

instance : ToString BExpr :=
let rec toString
| .const true => "⊤"
| .const false => "⊥"
| .var x => x
| .and p q => "(" ++ toString p ++ " ∧ " ++ toString q ++ ")"
| .or p q => "(" ++ toString p ++ " ∨ " ++ toString q ++ ")"
| .implies p q => "(" ++ toString p ++ " → " ++ toString q ++ ")"
| .not p => "¬" ++ toString p
| .iff p q => "(" ++ toString p ++ " ↔ " ++ toString q ++ ")"
⟨toString⟩

def getVars : BExpr → List String
| .var x => [x]
| .and p q | .or p q | .implies p q | .iff p q => getVars p ++ getVars q
| .not p => getVars p
| .const _ => []

def subst : BExpr → String → Bool → BExpr
| .var x, s, b => if x = s then .const b else .var x
| .and p q, s, b => .and (subst p s b) (subst q s b)
| .or p q, s, b => .or (subst p s b) (subst q s b)
| .implies p q, s, b => .implies (subst p s b) (subst q s b)
| .iff p q, s, b => .iff (subst p s b) (subst q s b)
| .not p, s, b => .not (subst p s b)
| .const v, _, _ => .const v

def substAll (asgns : List (String × Bool)) (e : BExpr) : BExpr :=
  asgns.foldl (λ | acc, (v, b) => subst acc v b) e

def eval : BExpr → Option Bool
| .const b => some b
| .and p q => do (← eval p) && (← eval q)
| .or p q => do (← eval p) || (← eval q)
| .implies p q => do (not (← eval p)) || (← eval q)
| .not p => do not (← eval p)
| .var _ => none
| .iff p q => do (← eval p) == (← eval q)

def generateSubExprs : BExpr → List BExpr
| .const _ => [] -- we don't need to examine truth vals of ⊤/⊥
| .var x => [.var x]
| e@(.or p q) | e@(.and p q) | e@(.implies p q) | e@(.iff p q) =>
  generateSubExprs p ++ generateSubExprs q ++ [e]
| .not p => generateSubExprs p ++ [.not p]

def permuteVarVals : List String → List (List (String × Bool)) := λ vs =>
  let count := 2 ^ vs.length
  let rec helper : Nat → List (List (String × Bool))
  | 0 => []
  | .succ n =>
    vs.mapIdx (λ (i : Nat) (v : String) =>
      (v, decide $ ((count - n.succ) >>> i) % 2 = 0))
    :: helper n
  helper count

def List.uniqueAux {α} [DecidableEq α] : List α → List α → List α
| [], acc => acc.reverse
| x :: xs, acc => if x ∈ acc then uniqueAux xs acc else uniqueAux xs (x :: acc)

def List.unique {α} [DecidableEq α] (xs : List α) := uniqueAux xs []

def prefixVars : List BExpr → List BExpr × List BExpr
| [] => ([], [])
| e@(.var _) :: tt =>
    let (restV, restC) := prefixVars tt
    (e::restV, restC)
| e :: tt =>
    let (restV, restC) := prefixVars tt
    (restV, e::restC)

-- TODO: don't use imperative things that can crash and burn (`get!`)
def truthTable (e : BExpr) : List (List (String × Bool)) :=
  let vars := getVars e
  let (BVars, VExps) := prefixVars ((generateSubExprs e).unique)
  let subBExprs := BVars.append VExps
  let allAsgns := permuteVarVals vars.unique
  allAsgns.map (λ asgns =>
    subBExprs
    |> List.map (λ e => (toString e, e))
    |> List.map (λ | (s, e) => (s, substAll asgns e))
    |> List.map (λ | (s, e) => (s, (eval e).get!))
  )

def htmlOfTable : List (List (String × Bool)) → String :=
λ t =>
  -- Hacky workaround
  if h1 : t = [] then "" else
  "<table cellpadding=\"5\""
      ++ "style=\"border:1px solid gray; border-collapse: collapse\">"
  ++ "<thead><tr>"
  ++ List.foldl (λ acc p => acc ++ "<th style=\"border:1px solid gray\">"
                                ++ toString p.1 ++ "</th>") "" (t.head h1)
  ++ "</tr></thead><tbody>"
  ++ List.foldl (λ acc r =>
      acc ++ "<tr>"
          ++ r.foldl (λ acc p =>
          let txt := toString p.2
          let bg := if txt = "true" then "limegreen" else "lightcoral"
          acc ++ "<td style=\"border:1px solid gray; background-color:"
              ++ bg ++ "\">" ++ toString p.2 ++ "</td>") "" ++ "</tr>") "" t
  ++ "</tbody></table>"

def mkTableWidget (t : List (List (String × Bool))) :
    UserWidgetDefinition where
  name := "Truth Table"
  javascript :=  "
    import * as React from 'react';
    export default function(props) {
      return React.createElement('div', {dangerouslySetInnerHTML: {__html: '"
        ++ htmlOfTable t
        ++ "'}})
    }"

def null := Lean.Json.null

syntax (name := truthTableCommand) "#truth_table" term : command

partial def bExprOfPropTerm :
  TSyntax `term → Elab.Command.CommandElabM (TSyntax `term)
| `(($P)) => bExprOfPropTerm P
| `($P ∧ $Q) => do `(.and ($(← bExprOfPropTerm P)) ($(← bExprOfPropTerm Q)))
| `($P ∨ $Q) => do `(.or ($(← bExprOfPropTerm P)) ($(← bExprOfPropTerm Q)))
| `($P → $Q) => do `(.implies ($(← bExprOfPropTerm P)) ($(← bExprOfPropTerm Q)))
| `($P ↔ $Q) => do `(.iff ($(← bExprOfPropTerm P)) ($(← bExprOfPropTerm Q)))
| `(¬ $P) => do `(.not ($(← bExprOfPropTerm P)))
| `(True) => do `(.const true)
| `(False) => do `(.const false)
-- We don't need this, but its breaking things may indicate a Lean bug
-- | `(¬ ($P)) => do `(.not ($(← bExprOfPropTerm P)))
| p =>
  let vnm := p.raw.getId.toString

  match p.raw.isIdent with
  | false => throwError ("Illegal Expression " ++ (toString p.raw))
  | true => `(.var $(Syntax.mkStrLit vnm))

-- TODO: This approach should be more robust, but it doesn't appear that Lean 4
-- currently supports antiquotations of `Expr`s out of the box, and adding the
-- `quote4` dependency could create even more headaches.
-- partial def bExprOfPropTerm : Expr → Elab.TermElabM (TSyntax `term)
-- | .app nm e' => do
--   -- This is inadequate -- `nm` might actually be an application itself
--   -- (consider `Or (And P Q) R`)
--   let isNot : Bool ← Meta.isExprDefEq nm (.const `Not [.succ .zero])
--   if isNot
--   then `(BExpr.not ($(← bExprOfPropTerm e')))
--   else
--     let isAnd : Bool ← Meta.isExprDefEq nm (.const `And [.succ .zero])
--     sorry
-- | _ => sorry

@[command_elab «truthTableCommand»] private unsafe def elabTableWidget :
  Elab.Command.CommandElab :=
  open Lean Lean.Elab Command Term in λ
  | stx@`(#truth_table $prop) => do
    let ident ← mkFreshIdent stx
    let decl := Lean.Syntax.getId ident
    let ident := mkIdent decl

    -- let tbStx : Lean.TSyntax `term ← Lean.Elab.Command.runTermElabM (λ _ =>
    --   do bExprOfPropTerm (← Lean.Elab.Term.elabType prop))


    elabDeclaration (←
      `(@[widget] def $ident :=
        mkTableWidget (truthTable $(← bExprOfPropTerm prop)))
      -- `(@[widget] def $ident := mkTableWidget (truthTable $tbStx)))
    )

    let null_stx ← `(Json.null)
    let props : Json ← runTermElabM fun _ =>
      Term.evalTerm Json (mkConst ``Json) null_stx
    saveWidgetInfo decl props stx
  | _ => throwUnsupportedSyntax
