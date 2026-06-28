"""Algebraic normal form helpers for DiffEML Boolean circuits.

ANF represents a Boolean function as an XOR of conjunction terms over GF(2).
This matches the hard DiffEML gate library well: each term is an AND tree, and
the polynomial readout is a left-associative XOR accumulator.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

import jax.numpy as jnp
from jax import Array

from alberta_framework.core.diffeml import (
    DiffEMLGateLibrary,
    boolean_truth_table,
    eml_threshold_gate_library,
)

AND_GATE_MASK = 8
"""Two-input AND mask in the DiffEML truth-table convention."""

XOR_GATE_MASK = 6
"""Two-input XOR mask in the DiffEML truth-table convention."""

CONST_ZERO_SOURCE = -1
"""Compiled-circuit source id for constant zero."""

CONST_ONE_SOURCE = -2
"""Compiled-circuit source id for constant one."""


@dataclass(frozen=True)
class ANFTerm:
    """One conjunction term in an algebraic normal form polynomial.

    ``variables=()`` is the constant-one term. Otherwise, variables are input
    column indices whose Boolean conjunction forms the term value.
    """

    variables: tuple[int, ...]

    def __post_init__(self) -> None:
        """Validate and canonicalize the variable tuple."""
        variables = tuple(int(variable) for variable in self.variables)
        if any(variable < 0 for variable in variables):
            raise ValueError("term variables must be non-negative")
        if len(set(variables)) != len(variables):
            raise ValueError("term variables must be unique")
        object.__setattr__(self, "variables", tuple(sorted(variables)))

    @property
    def degree(self) -> int:
        """Number of variables in the conjunction."""
        return len(self.variables)

    def mask(self, num_variables: int) -> int:
        """Return this term's row-order bit mask for ``num_variables`` inputs."""
        return variables_to_term_index(self.variables, num_variables)

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {"variables": list(self.variables), "degree": self.degree}


@dataclass(frozen=True)
class SparseANFGreedyStep:
    """Diagnostics for one greedy sparse-ANF selection."""

    term: ANFTerm
    residual_errors_before: int
    residual_errors_after: int
    net_improvement: int
    residual_hits: int
    spillovers: int

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {
            "term": self.term.to_config(),
            "residual_errors_before": self.residual_errors_before,
            "residual_errors_after": self.residual_errors_after,
            "net_improvement": self.net_improvement,
            "residual_hits": self.residual_hits,
            "spillovers": self.spillovers,
        }


@dataclass(frozen=True)
class SparseANFModel:
    """A sparse ANF model learned over Boolean input columns."""

    num_variables: int
    terms: tuple[ANFTerm, ...]
    training_errors: int
    steps: tuple[SparseANFGreedyStep, ...]

    def predict(self, inputs: Array) -> Array:
        """Evaluate the sparse ANF model on a Boolean input matrix."""
        return evaluate_anf(inputs, self.terms, num_variables=self.num_variables)

    def coefficients(self) -> Array:
        """Return dense ANF coefficients in truth-table row order."""
        coefficients = jnp.zeros((1 << self.num_variables,), dtype=jnp.int32)
        for term in self.terms:
            coefficients = coefficients.at[term.mask(self.num_variables)].set(1)
        return coefficients

    def export_eml(self) -> EMLANFExport:
        """Compile the model into fixed AND/XOR DiffEML gate masks."""
        return export_anf_to_eml(self.terms, self.num_variables)

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {
            "num_variables": self.num_variables,
            "terms": [term.to_config() for term in self.terms],
            "training_errors": self.training_errors,
            "steps": [step.to_config() for step in self.steps],
        }


@dataclass(frozen=True)
class EMLGateNode:
    """One fixed two-input gate in an exported DiffEML circuit."""

    output: int
    left: int
    right: int
    mask: int

    def to_config(self) -> dict[str, int]:
        """Return a JSON-serializable representation."""
        return {
            "output": self.output,
            "left": self.left,
            "right": self.right,
            "mask": self.mask,
        }


@dataclass(frozen=True)
class EMLANFTermExport:
    """Compiled representation of one ANF term as an AND tree."""

    term: ANFTerm
    variable_mask: int
    output_source: int
    and_gates: tuple[EMLGateNode, ...]

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {
            "term": self.term.to_config(),
            "variable_mask": self.variable_mask,
            "output_source": self.output_source,
            "and_gates": [gate.to_config() for gate in self.and_gates],
        }


@dataclass(frozen=True)
class EMLANFExport:
    """Fixed-gate DiffEML export for a sparse ANF polynomial."""

    num_variables: int
    terms: tuple[EMLANFTermExport, ...]
    xor_gates: tuple[EMLGateNode, ...]
    output_source: int
    and_gate_mask: int = AND_GATE_MASK
    xor_gate_mask: int = XOR_GATE_MASK
    constant_zero_source: int = CONST_ZERO_SOURCE
    constant_one_source: int = CONST_ONE_SOURCE
    and_gate_expression: str = "AND"
    xor_gate_expression: str = "XOR"

    @property
    def gate_count(self) -> int:
        """Total number of fixed binary gates in the export."""
        return sum(len(term.and_gates) for term in self.terms) + len(self.xor_gates)

    @property
    def gate_masks(self) -> tuple[int, ...]:
        """Gate masks used by this export, in execution order."""
        term_masks = tuple(
            gate.mask for term in self.terms for gate in term.and_gates
        )
        xor_masks = tuple(gate.mask for gate in self.xor_gates)
        return term_masks + xor_masks

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {
            "num_variables": self.num_variables,
            "terms": [term.to_config() for term in self.terms],
            "xor_gates": [gate.to_config() for gate in self.xor_gates],
            "output_source": self.output_source,
            "and_gate_mask": self.and_gate_mask,
            "xor_gate_mask": self.xor_gate_mask,
            "constant_zero_source": self.constant_zero_source,
            "constant_one_source": self.constant_one_source,
            "and_gate_expression": self.and_gate_expression,
            "xor_gate_expression": self.xor_gate_expression,
        }


class GreedySparseANFLearner:
    """Greedy sparse ANF learner for Boolean labels.

    Candidate terms are conjunctions up to ``max_degree``. Each selected term
    toggles the current prediction through the ANF XOR accumulator. Zero-net
    residual steps are allowed by default because parity functions have no
    single-variable Hamming improvement from the all-zero model, but they are
    recoverable after neutral GF(2) toggles.
    """

    def __init__(
        self,
        *,
        max_terms: int | None = None,
        max_degree: int | None = None,
        include_constant: bool = True,
        allow_neutral_steps: bool = True,
    ) -> None:
        """Initialize the greedy sparse-ANF learner."""
        if max_terms is not None and max_terms <= 0:
            raise ValueError("max_terms must be positive when provided")
        if max_degree is not None and max_degree < 0:
            raise ValueError("max_degree must be non-negative when provided")
        self.max_terms = max_terms
        self.max_degree = max_degree
        self.include_constant = include_constant
        self.allow_neutral_steps = allow_neutral_steps

    def fit(self, inputs: Array, labels: Array) -> SparseANFModel:
        """Fit a sparse ANF model to binary labels over Boolean inputs."""
        x = _as_binary_matrix(inputs)
        y = _as_binary_vector(labels, name="labels")
        if y.shape[0] != x.shape[0]:
            raise ValueError("labels length must match inputs rows")

        num_variables = int(x.shape[1])
        max_degree = num_variables if self.max_degree is None else self.max_degree
        if max_degree > num_variables:
            raise ValueError("max_degree must be <= number of input variables")
        max_terms = self.max_terms
        if max_terms is None:
            max_terms = len(generate_anf_terms(num_variables, max_degree=max_degree))

        candidates = list(
            generate_anf_terms(
                num_variables,
                max_degree=max_degree,
                include_constant=self.include_constant,
            )
        )
        selected: list[ANFTerm] = []
        steps: list[SparseANFGreedyStep] = []
        predictions = jnp.zeros_like(y)

        for _ in range(max_terms):
            residual = jnp.bitwise_xor(y, predictions)
            errors_before = int(jnp.sum(residual))
            if errors_before == 0:
                break

            residual_truth_table = _truth_table_from_complete_inputs(x, residual)
            residual_coefficients = (
                None
                if residual_truth_table is None
                else truth_table_to_anf(residual_truth_table, num_variables=num_variables)
            )
            algebraic_candidate_indices = _algebraic_candidate_indices(
                candidates,
                residual_coefficients,
                num_variables,
            )
            best_index = -1
            best_feature = jnp.zeros_like(y)
            best_hits = 0
            best_spillovers = 0
            best_net = -x.shape[0] - 1
            best_score = (-x.shape[0] - 1, -x.shape[0] - 1, -1, -1, 0)

            for candidate_index, candidate in enumerate(candidates):
                if algebraic_candidate_indices and (
                    candidate_index not in algebraic_candidate_indices
                ):
                    continue
                feature = evaluate_anf_terms(x, (candidate,), num_variables=num_variables)[:, 0]
                hits = int(jnp.sum(jnp.logical_and(feature == 1, residual == 1)))
                spillovers = int(jnp.sum(jnp.logical_and(feature == 1, residual == 0)))
                if hits == 0 and not algebraic_candidate_indices:
                    continue
                net = hits - spillovers
                if algebraic_candidate_indices:
                    score = (-candidate.degree, net, -spillovers, hits, -candidate_index)
                else:
                    score = (net, -spillovers, hits, -candidate.degree, -candidate_index)
                if score > best_score:
                    best_index = candidate_index
                    best_feature = feature
                    best_hits = hits
                    best_spillovers = spillovers
                    best_net = net
                    best_score = score

            if best_index < 0:
                break
            if best_net < 0 and not algebraic_candidate_indices:
                break
            if best_net == 0 and not self.allow_neutral_steps:
                break

            term = candidates.pop(best_index)
            predictions = jnp.bitwise_xor(predictions, best_feature)
            errors_after = int(jnp.sum(jnp.bitwise_xor(y, predictions)))
            selected.append(term)
            steps.append(
                SparseANFGreedyStep(
                    term=term,
                    residual_errors_before=errors_before,
                    residual_errors_after=errors_after,
                    net_improvement=best_net,
                    residual_hits=best_hits,
                    spillovers=best_spillovers,
                )
            )

        training_errors = int(jnp.sum(jnp.bitwise_xor(y, predictions)))
        return SparseANFModel(
            num_variables=num_variables,
            terms=tuple(selected),
            training_errors=training_errors,
            steps=tuple(steps),
        )


def all_boolean_inputs(num_variables: int) -> Array:
    """Return all Boolean assignments in truth-table row order.

    For two variables this matches DiffEML's ``00, 01, 10, 11`` convention.
    """
    if num_variables <= 0:
        raise ValueError("num_variables must be positive")
    rows = 1 << num_variables
    values = [
        [(row >> (num_variables - 1 - variable)) & 1 for variable in range(num_variables)]
        for row in range(rows)
    ]
    return jnp.asarray(values, dtype=jnp.int32)


def truth_table_to_anf(truth_table: Array, num_variables: int | None = None) -> Array:
    """Convert a truth table to dense ANF coefficients over GF(2).

    Coefficients are returned in the same row-order convention as the truth
    table. Use :func:`term_index_to_variables` to map a nonzero coefficient
    index to the corresponding conjunction variables.
    """
    values = _as_binary_vector(truth_table, name="truth_table")
    inferred_variables = _infer_num_variables(values.shape[0])
    if num_variables is None:
        num_variables = inferred_variables
    elif num_variables != inferred_variables:
        raise ValueError("truth_table length must equal 2 ** num_variables")
    return _mobius_transform_gf2(values, num_variables)


def anf_to_truth_table(coefficients: Array, num_variables: int | None = None) -> Array:
    """Convert dense ANF coefficients back to a truth table over GF(2)."""
    values = _as_binary_vector(coefficients, name="coefficients")
    inferred_variables = _infer_num_variables(values.shape[0])
    if num_variables is None:
        num_variables = inferred_variables
    elif num_variables != inferred_variables:
        raise ValueError("coefficients length must equal 2 ** num_variables")
    return _mobius_transform_gf2(values, num_variables)


def term_index_to_variables(index: int, num_variables: int) -> tuple[int, ...]:
    """Map a row-order ANF coefficient index to input variable columns."""
    if num_variables <= 0:
        raise ValueError("num_variables must be positive")
    if index < 0 or index >= (1 << num_variables):
        raise ValueError("index must be in [0, 2 ** num_variables)")
    return tuple(
        variable
        for variable in range(num_variables)
        if index & (1 << (num_variables - 1 - variable))
    )


def variables_to_term_index(variables: tuple[int, ...], num_variables: int) -> int:
    """Map input variable columns to a row-order ANF coefficient index."""
    if num_variables <= 0:
        raise ValueError("num_variables must be positive")
    term = ANFTerm(variables)
    if term.variables and term.variables[-1] >= num_variables:
        raise ValueError("term variables must be < num_variables")
    index = 0
    for variable in term.variables:
        index |= 1 << (num_variables - 1 - variable)
    return index


def anf_terms_from_coefficients(
    coefficients: Array,
    num_variables: int | None = None,
) -> tuple[ANFTerm, ...]:
    """Return nonzero ANF terms from dense GF(2) coefficients."""
    coeffs = _as_binary_vector(coefficients, name="coefficients")
    inferred_variables = _infer_num_variables(coeffs.shape[0])
    if num_variables is None:
        num_variables = inferred_variables
    elif num_variables != inferred_variables:
        raise ValueError("coefficients length must equal 2 ** num_variables")
    return tuple(
        ANFTerm(term_index_to_variables(index, num_variables))
        for index, coefficient in enumerate(coeffs.tolist())
        if int(coefficient) == 1
    )


def generate_anf_terms(
    num_variables: int,
    *,
    max_degree: int | None = None,
    include_constant: bool = True,
) -> tuple[ANFTerm, ...]:
    """Generate conjunction terms ordered by degree, then variable tuple."""
    if num_variables <= 0:
        raise ValueError("num_variables must be positive")
    if max_degree is None:
        max_degree = num_variables
    if max_degree < 0:
        raise ValueError("max_degree must be non-negative")
    if max_degree > num_variables:
        raise ValueError("max_degree must be <= num_variables")

    terms: list[ANFTerm] = []
    if include_constant:
        terms.append(ANFTerm(()))
    for degree in range(1, max_degree + 1):
        terms.extend(
            ANFTerm(tuple(variables))
            for variables in combinations(range(num_variables), degree)
        )
    return tuple(terms)


def evaluate_anf_terms(
    inputs: Array,
    terms: tuple[ANFTerm, ...],
    *,
    num_variables: int | None = None,
) -> Array:
    """Evaluate conjunction features for ANF terms on a Boolean matrix."""
    x = _as_binary_matrix(inputs)
    if num_variables is None:
        num_variables = int(x.shape[1])
    elif num_variables != int(x.shape[1]):
        raise ValueError("inputs column count must match num_variables")
    for term in terms:
        _validate_term_bounds(term, num_variables)

    if not terms:
        return jnp.zeros((x.shape[0], 0), dtype=jnp.int32)

    columns: list[Array] = []
    for term in terms:
        if term.degree == 0:
            columns.append(jnp.ones((x.shape[0],), dtype=jnp.int32))
        else:
            variable_indices = jnp.asarray(term.variables, dtype=jnp.int32)
            term_inputs = jnp.take(x, variable_indices, axis=1)
            columns.append(jnp.all(term_inputs == 1, axis=1).astype(jnp.int32))
    return jnp.stack(columns, axis=1)


def evaluate_anf(
    inputs: Array,
    terms: tuple[ANFTerm, ...],
    *,
    num_variables: int | None = None,
) -> Array:
    """Evaluate a sparse ANF polynomial by XORing conjunction features."""
    features = evaluate_anf_terms(inputs, terms, num_variables=num_variables)
    if features.shape[1] == 0:
        return jnp.zeros((features.shape[0],), dtype=jnp.int32)
    return jnp.mod(jnp.sum(features, axis=1), 2).astype(jnp.int32)


def evaluate_anf_coefficients(
    inputs: Array,
    coefficients: Array,
    *,
    num_variables: int | None = None,
) -> Array:
    """Evaluate dense ANF coefficients on a Boolean input matrix."""
    terms = anf_terms_from_coefficients(coefficients, num_variables=num_variables)
    if num_variables is None:
        num_variables = _infer_num_variables(_as_binary_vector(coefficients).shape[0])
    return evaluate_anf(inputs, terms, num_variables=num_variables)


def fit_sparse_anf_greedy(
    inputs: Array,
    labels: Array,
    *,
    max_terms: int | None = None,
    max_degree: int | None = None,
    include_constant: bool = True,
    allow_neutral_steps: bool = True,
) -> SparseANFModel:
    """Fit a greedy sparse ANF model with a function-style API."""
    learner = GreedySparseANFLearner(
        max_terms=max_terms,
        max_degree=max_degree,
        include_constant=include_constant,
        allow_neutral_steps=allow_neutral_steps,
    )
    return learner.fit(inputs, labels)


def export_anf_to_eml(
    terms: tuple[ANFTerm, ...],
    num_variables: int,
    *,
    and_gate_mask: int = AND_GATE_MASK,
    xor_gate_mask: int = XOR_GATE_MASK,
    library: DiffEMLGateLibrary | None = None,
) -> EMLANFExport:
    """Compile sparse ANF terms into fixed DiffEML AND/XOR gate masks."""
    if num_variables <= 0:
        raise ValueError("num_variables must be positive")
    for term in terms:
        _validate_term_bounds(term, num_variables)
    library = eml_threshold_gate_library(depth=2) if library is None else library
    and_expression = _witness_gate_mask(
        and_gate_mask,
        expected_mask=AND_GATE_MASK,
        library=library,
        name="and_gate_mask",
    )
    xor_expression = _witness_gate_mask(
        xor_gate_mask,
        expected_mask=XOR_GATE_MASK,
        library=library,
        name="xor_gate_mask",
    )

    next_node = num_variables
    exported_terms: list[EMLANFTermExport] = []
    for term in terms:
        and_gates: list[EMLGateNode] = []
        if term.degree == 0:
            output_source = CONST_ONE_SOURCE
        elif term.degree == 1:
            output_source = term.variables[0]
        else:
            current_source = term.variables[0]
            for variable in term.variables[1:]:
                output_source = next_node
                next_node += 1
                and_gates.append(
                    EMLGateNode(
                        output=output_source,
                        left=current_source,
                        right=variable,
                        mask=and_gate_mask,
                    )
                )
                current_source = output_source
            output_source = current_source
        exported_terms.append(
            EMLANFTermExport(
                term=term,
                variable_mask=term.mask(num_variables),
                output_source=output_source,
                and_gates=tuple(and_gates),
            )
        )

    xor_gates: list[EMLGateNode] = []
    if not exported_terms:
        output_source = CONST_ZERO_SOURCE
    elif len(exported_terms) == 1:
        output_source = exported_terms[0].output_source
    else:
        current_source = exported_terms[0].output_source
        for exported_term in exported_terms[1:]:
            output_source = next_node
            next_node += 1
            xor_gates.append(
                EMLGateNode(
                    output=output_source,
                    left=current_source,
                    right=exported_term.output_source,
                    mask=xor_gate_mask,
                )
            )
            current_source = output_source

    return EMLANFExport(
        num_variables=num_variables,
        terms=tuple(exported_terms),
        xor_gates=tuple(xor_gates),
        output_source=output_source,
        and_gate_mask=and_gate_mask,
        xor_gate_mask=xor_gate_mask,
        and_gate_expression=and_expression,
        xor_gate_expression=xor_expression,
    )


def validate_eml_anf_export(
    export: EMLANFExport,
    *,
    library: DiffEMLGateLibrary | None = None,
) -> bool:
    """Return whether an ANF export uses witnessed AND/XOR EML masks."""
    library = eml_threshold_gate_library(depth=2) if library is None else library
    try:
        _witness_gate_mask(
            export.and_gate_mask,
            expected_mask=AND_GATE_MASK,
            library=library,
            name="and_gate_mask",
        )
        _witness_gate_mask(
            export.xor_gate_mask,
            expected_mask=XOR_GATE_MASK,
            library=library,
            name="xor_gate_mask",
        )
    except ValueError:
        return False
    return all(mask in library.masks for mask in export.gate_masks)


def evaluate_eml_anf_export(export: EMLANFExport, inputs: Array) -> Array:
    """Evaluate an exported fixed-gate ANF circuit using its gate masks."""
    x = _as_binary_matrix(inputs)
    if int(x.shape[1]) != export.num_variables:
        raise ValueError("inputs column count must match export.num_variables")

    values: dict[int, Array] = {
        CONST_ZERO_SOURCE: jnp.zeros((x.shape[0],), dtype=jnp.int32),
        CONST_ONE_SOURCE: jnp.ones((x.shape[0],), dtype=jnp.int32),
    }
    for variable in range(export.num_variables):
        values[variable] = x[:, variable]

    for term in export.terms:
        for gate in term.and_gates:
            values[gate.output] = _apply_binary_gate_mask(
                values[gate.left],
                values[gate.right],
                gate.mask,
            )
    for gate in export.xor_gates:
        values[gate.output] = _apply_binary_gate_mask(
            values[gate.left],
            values[gate.right],
            gate.mask,
        )
    return values[export.output_source]


def _infer_num_variables(length: int) -> int:
    """Infer ``n`` from a vector length that must equal ``2 ** n``."""
    if length <= 0 or length & (length - 1):
        raise ValueError("truth-table length must be a positive power of two")
    return length.bit_length() - 1


def _mobius_transform_gf2(values: Array, num_variables: int) -> Array:
    """Apply the in-place-style subset Möbius transform over GF(2)."""
    transformed = values.astype(jnp.int32).reshape((2,) * num_variables)
    for axis in range(num_variables):
        lower = jnp.take(transformed, 0, axis=axis)
        upper = jnp.take(transformed, 1, axis=axis)
        updated_upper = jnp.bitwise_xor(upper, lower)
        transformed = jnp.concatenate(
            (
                jnp.expand_dims(lower, axis=axis),
                jnp.expand_dims(updated_upper, axis=axis),
            ),
            axis=axis,
        )
    return transformed.reshape(-1).astype(jnp.int32)


def _as_binary_vector(values: Array, *, name: str = "values") -> Array:
    """Convert an array-like input to a flat int32 binary vector."""
    array = jnp.asarray(values, dtype=jnp.int32).reshape(-1)
    if not bool(jnp.all(jnp.logical_or(array == 0, array == 1))):
        raise ValueError(f"{name} must contain only 0/1 values")
    return array


def _as_binary_matrix(values: Array) -> Array:
    """Convert an array-like input to a 2D int32 binary matrix."""
    array = jnp.asarray(values, dtype=jnp.int32)
    if array.ndim != 2:
        raise ValueError("inputs must have shape (n_samples, num_variables)")
    if not bool(jnp.all(jnp.logical_or(array == 0, array == 1))):
        raise ValueError("inputs must contain only 0/1 values")
    return array


def _truth_table_from_complete_inputs(inputs: Array, labels: Array) -> Array | None:
    """Return row-ordered labels when inputs contain each Boolean assignment."""
    num_variables = int(inputs.shape[1])
    expected_rows = 1 << num_variables
    if int(inputs.shape[0]) != expected_rows:
        return None

    powers = jnp.asarray(
        [1 << (num_variables - 1 - variable) for variable in range(num_variables)],
        dtype=jnp.int32,
    )
    row_indices = jnp.sum(inputs * powers, axis=1).astype(jnp.int32)
    index_values = [int(index) for index in row_indices.tolist()]
    if sorted(index_values) != list(range(expected_rows)):
        return None

    label_values = [int(label) for label in labels.tolist()]
    truth_table = [0] * expected_rows
    for index, label in zip(index_values, label_values, strict=True):
        truth_table[index] = label
    return jnp.asarray(truth_table, dtype=jnp.int32)


def _algebraic_candidate_indices(
    candidates: list[ANFTerm],
    residual_coefficients: Array | None,
    num_variables: int,
) -> set[int]:
    """Return candidates present in a complete-domain residual ANF."""
    if residual_coefficients is None:
        return set()
    return {
        candidate_index
        for candidate_index, candidate in enumerate(candidates)
        if int(residual_coefficients[candidate.mask(num_variables)]) == 1
    }


def _validate_term_bounds(term: ANFTerm, num_variables: int) -> None:
    """Validate that a term references existing input columns."""
    if num_variables <= 0:
        raise ValueError("num_variables must be positive")
    if term.variables and term.variables[-1] >= num_variables:
        raise ValueError("term variables must be < num_variables")


def _witness_gate_mask(
    mask: int,
    *,
    expected_mask: int,
    library: DiffEMLGateLibrary,
    name: str,
) -> str:
    """Return the EML expression witnessing a fixed Boolean gate mask."""
    if mask != expected_mask:
        raise ValueError(f"{name} must be mask {expected_mask}")
    if mask not in library.masks:
        raise ValueError(f"{name} is not present in the EML gate library")
    index = library.masks.index(mask)
    if not bool(jnp.array_equal(library.outputs[index], boolean_truth_table(expected_mask))):
        raise ValueError(f"{name} truth table does not match expected mask")
    return library.expressions[index]


def _apply_binary_gate_mask(left: Array, right: Array, mask: int) -> Array:
    """Apply one DiffEML two-input truth-table mask to binary vectors."""
    table = boolean_truth_table(mask).astype(jnp.int32)
    row_indices = left.astype(jnp.int32) * 2 + right.astype(jnp.int32)
    return table[row_indices].astype(jnp.int32)
