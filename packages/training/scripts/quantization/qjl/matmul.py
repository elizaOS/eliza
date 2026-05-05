import torch
from qjl_kernel import quantization

def cuda_quantized_bmm_dynamic(group_size: int,
                               fA: torch.FloatTensor,
                               qB: torch.IntTensor,
                               scales: torch.FloatTensor,
                               zeros: torch.FloatTensor,
                               bits: int,
                               mqa: bool = False) -> torch.FloatTensor:
    assert len(fA.shape) == 4 and len(qB.shape) == 4
    B, nh, M, K = fA.shape
    feat_per_int = 32 // bits
    fA = fA.view(-1, M, K).contiguous()
    N = qB.shape[-1] * feat_per_int
    qB = qB.reshape(-1, K, qB.shape[-1]).transpose(1, 2).contiguous()
    flatten_B = B * nh
    if mqa:
        flatten_B = B

    scales = scales.view(flatten_B, scales.shape[-2], scales.shape[-1]).transpose(1, 2).contiguous()
    zeros = zeros.view(flatten_B, zeros.shape[-2], zeros.shape[-1]).transpose(1, 2).contiguous()

    assert bits in [2, 4]

    if fA.dtype == torch.float16:
        result_tensor = quantization.batchedQuantizedMultiplyAccumulate_half(fA, qB, scales, zeros, bits, group_size, nh, mqa)
    elif fA.dtype == torch.float32:
        result_tensor = quantization.batchedQuantizedMultiplyAccumulate_float(fA, qB, scales, zeros, bits, group_size, nh, mqa)
    elif fA.dtype == torch.bfloat16:
        result_tensor = quantization.batchedQuantizedMultiplyAccumulate_bf16(fA, qB, scales, zeros, bits, group_size, nh, mqa)
    else:
        raise TypeError("Unsupported dtype for tensor fA. Expected float16 or float32 or bfloat16.")

    result_tensor = result_tensor.view(B, nh, result_tensor.shape[-2], result_tensor.shape[-1])
    return result_tensor