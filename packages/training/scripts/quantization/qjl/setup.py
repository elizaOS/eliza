"""Build the four QJL CUDA C++ extensions in csrc/.

Each ``.cu`` is templated on EMB_DIM (head_dim) and instantiated for
{128, 256} inside the file's PYBIND11_MODULE block, so a single
``setup.py build_ext --inplace`` produces one .so per kernel that exposes
both head_dim variants. The Python wrapper (``qjl_kernel.py``) picks the
right binding at call time based on input tensor shape.

Compute capability is selected via the standard PyTorch
``TORCH_CUDA_ARCH_LIST`` environment variable. Use ``build.sh`` for an
auto-detected default (sm_80/sm_90 on Ampere/Hopper, sm_120 on Blackwell).
"""

from setuptools import setup
from torch.utils.cpp_extension import BuildExtension, CUDAExtension
import os


def append_nvcc_threads(nvcc_extra_args):
    nvcc_threads = os.getenv("NVCC_THREADS") or "8"
    common_nvcc_args = [
        "-O3",
        "-std=c++17",
        "--expt-relaxed-constexpr",
        "--expt-extended-lambda",
        "--use_fast_math",
        "--threads=" + nvcc_threads,
    ]
    return nvcc_extra_args + common_nvcc_args


ext_modules = [
    CUDAExtension(
        name="cuda_qjl_score",
        sources=["csrc/qjl_score_kernel.cu"],
        extra_compile_args={
            "cxx": ["-g", "-O3"],
            "nvcc": append_nvcc_threads([]),
        },
    ),
    CUDAExtension(
        name="cuda_qjl_quant",
        sources=["csrc/qjl_quant_kernel.cu"],
        extra_compile_args={
            "cxx": ["-g", "-O3"],
            "nvcc": append_nvcc_threads([]),
        },
    ),
    CUDAExtension(
        name="cuda_qjl_gqa_score",
        sources=["csrc/qjl_gqa_score_kernel.cu"],
        extra_compile_args={
            "cxx": ["-g", "-O3"],
            "nvcc": append_nvcc_threads([]),
        },
    ),
    CUDAExtension(
        name="quantization",
        sources=["csrc/quantization.cu"],
        extra_compile_args={
            "cxx": ["-g", "-O3", "-fopenmp", "-lgomp", "-std=c++17", "-DENABLE_BF16"],
            "nvcc": append_nvcc_threads([
                "-DENABLE_BF16",
                "-U__CUDA_NO_HALF_OPERATORS__",
                "-U__CUDA_NO_HALF_CONVERSIONS__",
                "-U__CUDA_NO_BFLOAT16_OPERATORS__",
                "-U__CUDA_NO_BFLOAT16_CONVERSIONS__",
                "-U__CUDA_NO_BFLOAT162_OPERATORS__",
                "-U__CUDA_NO_BFLOAT162_CONVERSIONS__",
            ]),
        },
    ),
]

setup(
    name="combined_cuda_extensions",
    ext_modules=ext_modules,
    cmdclass={"build_ext": BuildExtension},
    install_requires=["torch"],
)
