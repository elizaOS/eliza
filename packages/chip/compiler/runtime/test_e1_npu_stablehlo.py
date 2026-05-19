import pytest
from e1_npu_stablehlo import (
    OP_ADD,
    OP_ATTENTION_AV,
    OP_ATTENTION_QK,
    OP_BATCH_MATMUL,
    OP_BIAS_ADD,
    OP_CONVOLUTION,
    OP_DOT,
    OP_DOT_GENERAL,
    OP_MLP,
    SUPPORTED_PRECISIONS,
    Add,
    AttentionAv,
    AttentionQk,
    BatchMatmul,
    BiasAdd,
    Convolution,
    Dot,
    DotGeneral,
    Mlp,
    StableHloParseError,
    StableHloValidationError,
    TensorType,
    materialize_lowering_graph,
    materialize_module_lowering_graphs,
    materialize_op_lowering_graph,
    parse_module,
    plan_module_lowerings,
    plan_op_lowering,
    serialize_module,
    validate_module,
)


def _dot_payload(precision: str, *, op: str = OP_DOT_GENERAL) -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_dot_smoke",
        "ops": [
            {
                "op": op,
                "name": "dot0",
                "lhs_type": {"shape": [2, 3], "dtype": precision},
                "rhs_type": {"shape": [3, 2], "dtype": precision},
                "result_type": {"shape": [2, 2], "dtype": precision},
                "precision": precision,
            }
        ],
    }


def _batch_matmul_payload(precision: str) -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_batch_matmul_smoke",
        "ops": [
            {
                "op": OP_BATCH_MATMUL,
                "name": "batch0",
                "lhs_type": {"shape": [2, 2, 2, 3], "dtype": precision},
                "rhs_type": {"shape": [2, 2, 3, 2], "dtype": precision},
                "result_type": {"shape": [2, 2, 2, 2], "dtype": precision},
                "precision": precision,
            }
        ],
    }


def _conv2d_payload(precision: str) -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_conv2d_smoke",
        "ops": [
            {
                "op": OP_CONVOLUTION,
                "name": "conv0",
                "input_type": {"shape": [1, 3, 3, 1], "dtype": precision},
                "filter_type": {"shape": [2, 2, 1, 2], "dtype": precision},
                "result_type": {"shape": [1, 2, 2, 2], "dtype": precision},
                "precision": precision,
                "padding": "VALID",
                "stride": 1,
                "dilation": 1,
            }
        ],
    }


def _add_payload(precision: str = "int8") -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_add_smoke",
        "ops": [
            {
                "op": OP_ADD,
                "name": "add0",
                "lhs_type": {"shape": [2, 3], "dtype": precision},
                "rhs_type": {"shape": [2, 3], "dtype": precision},
                "result_type": {"shape": [2, 3], "dtype": precision},
                "precision": precision,
            }
        ],
    }


def _bias_add_payload(precision: str = "int8") -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_bias_add_smoke",
        "ops": [
            {
                "op": OP_BIAS_ADD,
                "name": "bias0",
                "input_type": {"shape": [2, 3], "dtype": precision},
                "bias_type": {"shape": [3], "dtype": precision},
                "result_type": {"shape": [2, 3], "dtype": precision},
                "precision": precision,
            }
        ],
    }


def _mlp_payload(precision: str = "int8", *, activation: str = "relu") -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_mlp_smoke",
        "ops": [
            {
                "op": OP_MLP,
                "name": "mlp0",
                "input_type": {"shape": [2, 2], "dtype": precision},
                "up_weight_type": {"shape": [2, 3], "dtype": precision},
                "down_weight_type": {"shape": [3, 2], "dtype": precision},
                "result_type": {"shape": [2, 2], "dtype": precision},
                "activation": activation,
                "precision": precision,
            }
        ],
    }


def _attention_qk_payload(precision: str = "int8") -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_attention_qk_smoke",
        "ops": [
            {
                "op": OP_ATTENTION_QK,
                "name": "qk0",
                "query_type": {"shape": [1, 2, 2, 3], "dtype": precision},
                "key_type": {"shape": [1, 2, 3, 3], "dtype": precision},
                "result_type": {"shape": [1, 2, 2, 3], "dtype": precision},
                "precision": precision,
            }
        ],
    }


def _attention_av_payload(precision: str = "int8") -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_attention_av_smoke",
        "ops": [
            {
                "op": OP_ATTENTION_AV,
                "name": "av0",
                "weights_type": {"shape": [1, 2, 2, 3], "dtype": precision},
                "value_type": {"shape": [1, 2, 3, 3], "dtype": precision},
                "result_type": {"shape": [1, 2, 2, 3], "dtype": precision},
                "precision": precision,
            }
        ],
    }


def test_stablehlo_subset_accepts_low_precision_rank2_dot_smoke_precisions():
    expected = {
        "int8",
        "int4",
        "int2",
        "bitnet_int2",
        "fp8_e4m3",
        "fp16",
        "float16",
        "bf16",
        "bfloat16",
        "sparse_int4_2_4",
        "int4_group_scaled",
        "group_scaled_int4",
        "w4a8_gs",
    }

    assert expected <= SUPPORTED_PRECISIONS
    for precision in sorted(expected):
        module = parse_module(_dot_payload(precision))

        assert validate_module(module) == []
        assert isinstance(module.ops[0], DotGeneral)
        assert module.ops[0].precision == precision
        assert serialize_module(module)["ops"][0]["precision"] == precision


def test_stablehlo_subset_accepts_stablehlo_dot_alias_for_matmul_smoke():
    module = parse_module(_dot_payload("int4_group_scaled", op=OP_DOT))

    assert validate_module(module) == []
    assert module.ops[0].op == OP_DOT


def test_stablehlo_subset_accepts_attention_qk_and_av_smoke_records():
    for precision in ("int8", "int4"):
        qk_module = parse_module(_attention_qk_payload(precision))
        av_module = parse_module(_attention_av_payload(precision))

        assert validate_module(qk_module) == []
        assert validate_module(av_module) == []
        assert isinstance(qk_module.ops[0], AttentionQk)
        assert isinstance(av_module.ops[0], AttentionAv)
        assert serialize_module(qk_module)["ops"][0]["precision"] == precision
        assert serialize_module(av_module)["ops"][0]["precision"] == precision


def test_stablehlo_subset_rejects_unsupported_dot_precision_and_tile_overflow():
    unsupported = parse_module(_dot_payload("mxint8"))
    issues = validate_module(unsupported)

    assert [issue.code for issue in issues] == ["UNSUPPORTED_PRECISION"]

    too_large = parse_module(
        {
            "schema": "eliza.e1_npu_stablehlo_subset.v1",
            "name": "too_large",
            "ops": [
                {
                    "op": OP_DOT_GENERAL,
                    "name": "dot0",
                    "lhs_type": {"shape": [4, 8], "dtype": "int8"},
                    "rhs_type": {"shape": [8, 4], "dtype": "int8"},
                    "result_type": {"shape": [4, 4], "dtype": "int8"},
                    "precision": "int8",
                }
            ],
        }
    )

    assert {issue.code for issue in validate_module(too_large)} == {
        "TILE_M_OUT_OF_RANGE",
        "TILE_N_OUT_OF_RANGE",
        "TILE_K_OUT_OF_RANGE",
    }


def test_stablehlo_subset_rejects_empty_modules_and_duplicate_op_names():
    empty = parse_module({"schema": "eliza.e1_npu_stablehlo_subset.v1", "name": "empty", "ops": []})
    duplicate = _dot_payload("int8")
    duplicate["ops"].append({**duplicate["ops"][0], "precision": "int4"})

    assert [issue.code for issue in validate_module(empty)] == ["MODULE_EMPTY"]
    assert "DUPLICATE_OP_NAME" in {issue.code for issue in validate_module(parse_module(duplicate))}
    with pytest.raises(StableHloValidationError, match="MODULE_EMPTY"):
        plan_module_lowerings(empty)
    with pytest.raises(StableHloValidationError, match="DUPLICATE_OP_NAME"):
        materialize_module_lowering_graphs(
            parse_module(duplicate),
            {"dot0": {"lhs": [[1, 2, 3]], "rhs": [[1], [2], [3]]}},
        )


def test_stablehlo_subset_plans_runtime_lowering_targets_for_low_precision_dot_modes():
    expected = {
        "int8": ("lower_matmul_smoke", "eliza.e1_npu_matmul_smoke.v1", "int8"),
        "int4": ("lower_matmul_smoke", "eliza.e1_npu_matmul_smoke.v1", "int4"),
        "int2": ("lower_int2_matmul_smoke", "eliza.e1_npu_int2_matmul_smoke.v1", "int2"),
        "bitnet_int2": (
            "lower_int2_matmul_smoke",
            "eliza.e1_npu_int2_matmul_smoke.v1",
            "bitnet_int2",
        ),
        "fp8_e4m3": (
            "lower_fp8_matmul_smoke",
            "eliza.e1_npu_fp8_matmul_smoke.v1",
            "fp8_e4m3",
        ),
        "fp16": ("lower_fp16_matmul_smoke", "eliza.e1_npu_fp16_matmul_smoke.v1", "fp16"),
        "float16": (
            "lower_fp16_matmul_smoke",
            "eliza.e1_npu_fp16_matmul_smoke.v1",
            "float16",
        ),
        "bf16": ("lower_bf16_matmul_smoke", "eliza.e1_npu_bf16_matmul_smoke.v1", "bf16"),
        "bfloat16": (
            "lower_bf16_matmul_smoke",
            "eliza.e1_npu_bf16_matmul_smoke.v1",
            "bfloat16",
        ),
        "sparse_int4_2_4": (
            "lower_sparse_int4_matmul_smoke",
            "eliza.e1_npu_sparse_int4_matmul_smoke.v1",
            "s4_2_4",
        ),
        "int4_group_scaled": (
            "lower_group_scaled_int4_matmul_smoke",
            "eliza.e1_npu_group_scaled_int4_matmul_smoke.v1",
            "int4_group_scaled",
        ),
        "group_scaled_int4": (
            "lower_group_scaled_int4_matmul_smoke",
            "eliza.e1_npu_group_scaled_int4_matmul_smoke.v1",
            "group_scaled_int4",
        ),
        "w4a8_gs": (
            "lower_group_scaled_int4_matmul_smoke",
            "eliza.e1_npu_group_scaled_int4_matmul_smoke.v1",
            "w4a8_gs",
        ),
    }

    for precision, (runtime_api, schema, lowering_precision) in expected.items():
        plan = plan_module_lowerings(parse_module(_dot_payload(precision)))[0]

        assert plan.runtime_api == runtime_api
        assert plan.schema == schema
        assert plan.lowering_precision == lowering_precision
        assert plan.input_shape == (2, 3)
        assert plan.output_shape == (2, 2)
        assert plan.claim_boundary


def test_stablehlo_subset_plans_bounded_batch_matmul_runtime_lowering():
    for precision in ("int8", "int4"):
        module = parse_module(_batch_matmul_payload(precision))
        plan = plan_module_lowerings(module)[0]

        assert isinstance(module.ops[0], BatchMatmul)
        assert validate_module(module) == []
        assert plan.runtime_api == "lower_batch_matmul_smoke"
        assert plan.schema == "eliza.e1_npu_batch_matmul_smoke.v1"
        assert plan.lowering_precision == precision
        assert plan.input_shape == (2, 2, 2, 3)
        assert plan.output_shape == (2, 2, 2, 2)
        assert plan.required_graph_fields == ("lhs", "rhs")
        assert "batch_matmul_reuses_tiled_matmul_smoke_only" in plan.claim_boundary


def test_stablehlo_subset_plans_bounded_convolution_runtime_lowering():
    for precision in ("int8", "int4"):
        module = parse_module(_conv2d_payload(precision))
        plan = plan_module_lowerings(module)[0]

        assert isinstance(module.ops[0], Convolution)
        assert validate_module(module) == []
        assert plan.runtime_api == "lower_conv2d_smoke"
        assert plan.schema == "eliza.e1_npu_conv2d_smoke.v1"
        assert plan.lowering_precision == precision
        assert plan.input_shape == (1, 3, 3, 1)
        assert plan.output_shape == (1, 2, 2, 2)
        assert plan.required_graph_fields == ("input", "filter")
        assert plan.static_graph_fields == {
            "data_format": "NHWC",
            "filter_format": "HWIO",
            "padding": "VALID",
            "strides": [1, 1],
            "dilations": [1, 1],
        }
        assert "single_conv2d_im2col_smoke_only" in plan.claim_boundary


def test_stablehlo_subset_plans_add_and_bias_add_runtime_lowering():
    add_module = parse_module(_add_payload())
    bias_module = parse_module(_bias_add_payload())
    add_plan = plan_module_lowerings(add_module)[0]
    bias_plan = plan_module_lowerings(bias_module)[0]

    assert isinstance(add_module.ops[0], Add)
    assert isinstance(bias_module.ops[0], BiasAdd)
    assert validate_module(add_module) == []
    assert validate_module(bias_module) == []
    assert add_plan.runtime_api == "lower_residual_add_smoke"
    assert add_plan.schema == "eliza.e1_npu_residual_add_smoke.v1"
    assert add_plan.required_graph_fields == ("lhs", "rhs")
    assert "residual_add_s8_scalar_smoke_only" in add_plan.claim_boundary
    assert bias_plan.runtime_api == "lower_bias_add_smoke"
    assert bias_plan.schema == "eliza.e1_npu_bias_add_smoke.v1"
    assert bias_plan.required_graph_fields == ("input", "bias")
    assert "bias_add_s8_scalar_broadcast_smoke_only" in bias_plan.claim_boundary


def test_stablehlo_subset_plans_mlp_runtime_lowering():
    module = parse_module(_mlp_payload())
    plan = plan_module_lowerings(module)[0]

    assert isinstance(module.ops[0], Mlp)
    assert validate_module(module) == []
    assert plan.runtime_api == "lower_mlp_smoke"
    assert plan.schema == "eliza.e1_npu_mlp_smoke.v1"
    assert plan.lowering_precision == "int8"
    assert plan.input_shape == (2, 2)
    assert plan.output_shape == (2, 2)
    assert plan.required_graph_fields == ("input", "up_weight", "down_weight")
    assert plan.static_graph_fields == {"activation": "relu", "requant_shift": 0}
    assert "transformer_mlp_relu_smoke_only" in plan.claim_boundary


def test_stablehlo_subset_plans_attention_qk_and_av_runtime_lowering():
    for precision in ("int8", "int4"):
        qk_plan = plan_module_lowerings(parse_module(_attention_qk_payload(precision)))[0]
        av_plan = plan_module_lowerings(parse_module(_attention_av_payload(precision)))[0]

        assert qk_plan.runtime_api == "lower_attention_qk_smoke"
        assert qk_plan.schema == "eliza.e1_npu_attention_qk_smoke.v1"
        assert qk_plan.lowering_precision == precision
        assert qk_plan.input_shape == (1, 2, 2, 3)
        assert qk_plan.output_shape == (1, 2, 2, 3)
        assert qk_plan.required_graph_fields == ("query", "key")
        assert "attention_qk_scores_smoke_only" in qk_plan.claim_boundary
        assert av_plan.runtime_api == "lower_attention_av_smoke"
        assert av_plan.schema == "eliza.e1_npu_attention_av_smoke.v1"
        assert av_plan.lowering_precision == precision
        assert av_plan.input_shape == (1, 2, 2, 3)
        assert av_plan.output_shape == (1, 2, 2, 3)
        assert av_plan.required_graph_fields == ("attention", "value")
        assert "attention_av_context_smoke_only" in av_plan.claim_boundary


def test_stablehlo_subset_rejects_batch_matmul_unsupported_precision_and_shape():
    unsupported = parse_module(_batch_matmul_payload("fp8_e4m3"))
    bad_shape_payload = _batch_matmul_payload("int8")
    bad_shape_payload["ops"][0]["result_type"] = {"shape": [2, 2, 2, 3], "dtype": "int8"}

    assert [issue.code for issue in validate_module(unsupported)] == ["UNSUPPORTED_PRECISION"]
    assert [issue.code for issue in validate_module(parse_module(bad_shape_payload))] == [
        "RESULT_SHAPE_MISMATCH"
    ]


def test_stablehlo_subset_rejects_convolution_unsupported_precision_and_shape():
    unsupported = parse_module(_conv2d_payload("fp8_e4m3"))
    bad_shape_payload = _conv2d_payload("int8")
    bad_shape_payload["ops"][0]["result_type"] = {"shape": [1, 2, 2, 3], "dtype": "int8"}
    bad_stride_payload = _conv2d_payload("int8")
    bad_stride_payload["ops"][0]["stride"] = 2

    assert [issue.code for issue in validate_module(unsupported)] == ["UNSUPPORTED_PRECISION"]
    assert [issue.code for issue in validate_module(parse_module(bad_shape_payload))] == [
        "RESULT_SHAPE_MISMATCH"
    ]
    assert [issue.code for issue in validate_module(parse_module(bad_stride_payload))] == [
        "STRIDE_UNSUPPORTED"
    ]


def test_stablehlo_subset_rejects_add_and_bias_add_unsupported_shapes():
    add_unsupported = parse_module(_add_payload("int4"))
    add_bad_shape_payload = _add_payload()
    add_bad_shape_payload["ops"][0]["rhs_type"] = {"shape": [2, 2], "dtype": "int8"}
    bias_bad_width_payload = _bias_add_payload()
    bias_bad_width_payload["ops"][0]["bias_type"] = {"shape": [2], "dtype": "int8"}
    bias_bad_result_payload = _bias_add_payload()
    bias_bad_result_payload["ops"][0]["result_type"] = {"shape": [2, 2], "dtype": "int8"}

    assert [issue.code for issue in validate_module(add_unsupported)] == ["UNSUPPORTED_PRECISION"]
    assert [issue.code for issue in validate_module(parse_module(add_bad_shape_payload))] == [
        "SHAPE_MISMATCH"
    ]
    assert [issue.code for issue in validate_module(parse_module(bias_bad_width_payload))] == [
        "SHAPE_MISMATCH"
    ]
    assert [issue.code for issue in validate_module(parse_module(bias_bad_result_payload))] == [
        "RESULT_SHAPE_MISMATCH"
    ]


def test_stablehlo_subset_rejects_mlp_unsupported_activation_precision_and_shape():
    unsupported_precision = parse_module(_mlp_payload("int4"))
    unsupported_activation = parse_module(_mlp_payload(activation="gelu"))
    bad_result_payload = _mlp_payload()
    bad_result_payload["ops"][0]["result_type"] = {"shape": [2, 3], "dtype": "int8"}

    assert [issue.code for issue in validate_module(unsupported_precision)] == [
        "UNSUPPORTED_PRECISION"
    ]
    assert [issue.code for issue in validate_module(unsupported_activation)] == [
        "ACTIVATION_UNSUPPORTED"
    ]
    assert [issue.code for issue in validate_module(parse_module(bad_result_payload))] == [
        "RESULT_SHAPE_MISMATCH"
    ]


def test_stablehlo_subset_rejects_attention_unsupported_precision_and_shape():
    qk_unsupported = parse_module(_attention_qk_payload("fp8_e4m3"))
    qk_bad_dim_payload = _attention_qk_payload()
    qk_bad_dim_payload["ops"][0]["key_type"] = {"shape": [1, 2, 3, 2], "dtype": "int8"}
    qk_bad_result_payload = _attention_qk_payload()
    qk_bad_result_payload["ops"][0]["result_type"] = {"shape": [1, 2, 2, 2], "dtype": "int8"}
    av_unsupported = parse_module(_attention_av_payload("fp8_e4m3"))
    av_bad_key_payload = _attention_av_payload()
    av_bad_key_payload["ops"][0]["value_type"] = {"shape": [1, 2, 2, 3], "dtype": "int8"}
    av_bad_result_payload = _attention_av_payload()
    av_bad_result_payload["ops"][0]["result_type"] = {"shape": [1, 2, 2, 2], "dtype": "int8"}

    assert [issue.code for issue in validate_module(qk_unsupported)] == ["UNSUPPORTED_PRECISION"]
    assert [issue.code for issue in validate_module(parse_module(qk_bad_dim_payload))] == [
        "SHAPE_MISMATCH"
    ]
    assert [issue.code for issue in validate_module(parse_module(qk_bad_result_payload))] == [
        "RESULT_SHAPE_MISMATCH"
    ]
    assert [issue.code for issue in validate_module(av_unsupported)] == ["UNSUPPORTED_PRECISION"]
    assert [issue.code for issue in validate_module(parse_module(av_bad_key_payload))] == [
        "SHAPE_MISMATCH"
    ]
    assert [issue.code for issue in validate_module(parse_module(av_bad_result_payload))] == [
        "RESULT_SHAPE_MISMATCH"
    ]


def test_stablehlo_subset_plans_required_graph_fields_for_metadata_backed_precisions():
    sparse_plan = plan_module_lowerings(parse_module(_dot_payload("sparse_int4_2_4")))[0]
    group_scaled_plan = plan_module_lowerings(parse_module(_dot_payload("int4_group_scaled")))[0]

    assert sparse_plan.required_graph_fields == ("lhs", "rhs_nonzero", "rhs_positions")
    assert group_scaled_plan.required_graph_fields == (
        "lhs",
        "rhs",
        "scales_q8_8",
        "group_size",
    )


def test_stablehlo_subset_materializes_runtime_smoke_graph_from_plan():
    plan = plan_module_lowerings(parse_module(_dot_payload("int8", op=OP_DOT)))[0]

    graph = materialize_lowering_graph(
        plan,
        {
            "lhs": [[1, -2, 3], [4, 5, -6]],
            "rhs": [[7, -8], [9, 10], [-11, 12]],
        },
    )

    assert graph == {
        "schema": "eliza.e1_npu_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": OP_DOT,
        "precision": "int8",
        "lhs": [[1, -2, 3], [4, 5, -6]],
        "rhs": [[7, -8], [9, 10], [-11, 12]],
    }


def test_stablehlo_subset_materializes_batch_matmul_smoke_graph_from_plan():
    plan = plan_module_lowerings(parse_module(_batch_matmul_payload("int8")))[0]

    graph = materialize_lowering_graph(
        plan,
        {
            "lhs": [[[[1, 2, 3], [4, 5, 6]]]],
            "rhs": [[[[7, 8], [9, 10], [11, 12]]]],
        },
    )

    assert graph == {
        "schema": "eliza.e1_npu_batch_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": OP_BATCH_MATMUL,
        "precision": "int8",
        "lhs": [[[[1, 2, 3], [4, 5, 6]]]],
        "rhs": [[[[7, 8], [9, 10], [11, 12]]]],
    }


def test_stablehlo_subset_materializes_convolution_smoke_graph_from_plan():
    plan = plan_module_lowerings(parse_module(_conv2d_payload("int8")))[0]

    graph = materialize_lowering_graph(
        plan,
        {
            "input": [[[[1], [2], [3]], [[4], [5], [6]], [[7], [8], [9]]]],
            "filter": [[[[1, -1]], [[2, 0]]], [[[0, 3]], [[-1, 1]]]],
        },
    )

    assert graph == {
        "schema": "eliza.e1_npu_conv2d_smoke.v1",
        "dialect": "stablehlo",
        "op": OP_CONVOLUTION,
        "precision": "int8",
        "data_format": "NHWC",
        "filter_format": "HWIO",
        "padding": "VALID",
        "strides": [1, 1],
        "dilations": [1, 1],
        "input": [[[[1], [2], [3]], [[4], [5], [6]], [[7], [8], [9]]]],
        "filter": [[[[1, -1]], [[2, 0]]], [[[0, 3]], [[-1, 1]]]],
    }


def test_stablehlo_subset_materializes_add_and_bias_add_smoke_graphs_from_plan():
    add_plan = plan_module_lowerings(parse_module(_add_payload()))[0]
    bias_plan = plan_module_lowerings(parse_module(_bias_add_payload()))[0]

    add_graph = materialize_lowering_graph(
        add_plan,
        {"lhs": [[1, -2, 120], [4, 5, -6]], "rhs": [[7, -8, 20], [9, 10, -127]]},
    )
    bias_graph = materialize_lowering_graph(
        bias_plan,
        {"input": [[1, -2, 120], [4, 5, -6]], "bias": [7, -8, 20]},
    )

    assert add_graph == {
        "schema": "eliza.e1_npu_residual_add_smoke.v1",
        "dialect": "stablehlo",
        "op": OP_ADD,
        "precision": "int8",
        "lhs": [[1, -2, 120], [4, 5, -6]],
        "rhs": [[7, -8, 20], [9, 10, -127]],
    }
    assert bias_graph == {
        "schema": "eliza.e1_npu_bias_add_smoke.v1",
        "dialect": "stablehlo",
        "op": OP_BIAS_ADD,
        "precision": "int8",
        "input": [[1, -2, 120], [4, 5, -6]],
        "bias": [7, -8, 20],
    }


def test_stablehlo_subset_materializes_mlp_smoke_graph_from_plan():
    plan = plan_module_lowerings(parse_module(_mlp_payload()))[0]

    graph = materialize_lowering_graph(
        plan,
        {
            "input": [[1, -2], [3, 4]],
            "up_weight": [[2, -1, 3], [-2, 1, 0]],
            "down_weight": [[1, -2], [-3, 4], [2, 1]],
        },
    )

    assert graph == {
        "schema": "eliza.e1_npu_mlp_smoke.v1",
        "dialect": "stablehlo",
        "op": OP_MLP,
        "precision": "int8",
        "activation": "relu",
        "requant_shift": 0,
        "input": [[1, -2], [3, 4]],
        "up_weight": [[2, -1, 3], [-2, 1, 0]],
        "down_weight": [[1, -2], [-3, 4], [2, 1]],
    }


def test_stablehlo_subset_materializes_attention_qk_and_av_smoke_graphs_from_plan():
    qk_plan = plan_module_lowerings(parse_module(_attention_qk_payload()))[0]
    av_plan = plan_module_lowerings(parse_module(_attention_av_payload()))[0]

    qk_graph = materialize_lowering_graph(
        qk_plan,
        {
            "query": [[[[1, -2, 3], [4, 5, -6]], [[1, 2, 3], [4, 5, 6]]]],
            "key": [
                [
                    [[7, -8, 9], [10, 11, -12], [1, 0, -1]],
                    [[-1, 2, -3], [4, -5, 6], [7, 8, 9]],
                ]
            ],
        },
    )
    av_graph = materialize_lowering_graph(
        av_plan,
        {
            "attention": [[[[1, 2, 3], [5, 6, 7]], [[-1, 2, -3], [5, -6, 7]]]],
            "value": [
                [
                    [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
                    [[-1, -2, -3], [4, 5, 6], [-7, 8, -9]],
                ]
            ],
        },
    )

    assert qk_graph["schema"] == "eliza.e1_npu_attention_qk_smoke.v1"
    assert qk_graph["op"] == OP_ATTENTION_QK
    assert qk_graph["precision"] == "int8"
    assert set(qk_graph) == {"schema", "dialect", "op", "precision", "query", "key"}
    assert av_graph["schema"] == "eliza.e1_npu_attention_av_smoke.v1"
    assert av_graph["op"] == OP_ATTENTION_AV
    assert av_graph["precision"] == "int8"
    assert set(av_graph) == {"schema", "dialect", "op", "precision", "attention", "value"}


def test_stablehlo_subset_materializes_metadata_backed_runtime_graphs():
    sparse_module = parse_module(_dot_payload("sparse_int4_2_4"))
    group_module = parse_module(_dot_payload("int4_group_scaled"))

    sparse_graph = materialize_module_lowering_graphs(
        sparse_module,
        {
            "dot0": {
                "lhs": [[1, -2, 3, -4, 5, -6, 7, -8]],
                "rhs_nonzero": [[[2, -3, 4, -5]]],
                "rhs_positions": [[[0, 2, 1, 3]]],
            }
        },
    )[0]
    group_graph = materialize_op_lowering_graph(
        group_module.ops[0],
        {
            "lhs": [[2, -3]],
            "rhs": [[3], [-4]],
            "scales_q8_8": [[128]],
            "group_size": 2,
        },
    )

    assert sparse_graph["schema"] == "eliza.e1_npu_sparse_int4_matmul_smoke.v1"
    assert sparse_graph["precision"] == "s4_2_4"
    assert tuple(sparse_graph) == (
        "schema",
        "dialect",
        "op",
        "precision",
        "lhs",
        "rhs_nonzero",
        "rhs_positions",
    )
    assert group_graph["schema"] == "eliza.e1_npu_group_scaled_int4_matmul_smoke.v1"
    assert group_graph["precision"] == "int4_group_scaled"
    assert tuple(group_graph) == (
        "schema",
        "dialect",
        "op",
        "precision",
        "lhs",
        "rhs",
        "scales_q8_8",
        "group_size",
    )


def test_stablehlo_subset_materializer_rejects_missing_unknown_and_invalid_inputs():
    plan = plan_module_lowerings(parse_module(_dot_payload("int8")))[0]

    with pytest.raises(StableHloValidationError, match="missing graph fields"):
        materialize_lowering_graph(plan, {"lhs": [[1]]})
    with pytest.raises(StableHloValidationError, match="unknown graph fields"):
        materialize_lowering_graph(plan, {"lhs": [[1]], "rhs": [[1]], "bias": [1]})
    with pytest.raises(StableHloValidationError, match="cannot materialize invalid"):
        materialize_op_lowering_graph(parse_module(_dot_payload("mxint8")).ops[0], {})
    with pytest.raises(StableHloValidationError, match="unknown graph field mappings"):
        materialize_module_lowering_graphs(
            parse_module(_dot_payload("int8")),
            {"dot0": {"lhs": [[1]], "rhs": [[1]]}, "extra": {}},
        )


def test_stablehlo_subset_refuses_to_plan_invalid_modules():
    module = parse_module(_dot_payload("mxint8"))

    with pytest.raises(
        StableHloValidationError, match="cannot plan invalid StableHLO subset module"
    ):
        plan_module_lowerings(module)


def test_stablehlo_dot_dataclass_preserves_explicit_dot_alias():
    op = Dot(
        name="dot_alias",
        result_type=TensorType((1, 1), "int8"),
        lhs_type=TensorType((1, 1), "int8"),
        rhs_type=TensorType((1, 1), "int8"),
        precision="int8",
    )

    assert op.as_dict()["op"] == OP_DOT
    module = parse_module(
        {"schema": "eliza.e1_npu_stablehlo_subset.v1", "name": "x", "ops": [op.as_dict()]}
    )
    assert validate_module(module) == []
    assert plan_op_lowering(module.ops[0]).source_op == OP_DOT


def test_stablehlo_parser_still_rejects_unknown_ops():
    with pytest.raises(StableHloParseError, match="unsupported op"):
        parse_module(
            {
                "schema": "eliza.e1_npu_stablehlo_subset.v1",
                "name": "unknown",
                "ops": [
                    {
                        "op": "stablehlo.custom_call",
                        "name": "bad",
                        "result_type": {"shape": [1], "dtype": "int8"},
                    }
                ],
            }
        )
