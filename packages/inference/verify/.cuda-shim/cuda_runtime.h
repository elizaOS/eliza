#pragma once
#include <cstdint>
#include <cstddef>
typedef int cudaError_t;
typedef struct CUstream_st * cudaStream_t;
enum { cudaSuccess = 0, cudaMemcpyHostToDevice = 1, cudaMemcpyDeviceToHost = 2 };
cudaError_t cudaMalloc(void **, size_t);
cudaError_t cudaFree(void *);
cudaError_t cudaMemcpy(void *, const void *, size_t, int);
cudaError_t cudaMemset(void *, int, size_t);
cudaError_t cudaSetDevice(int);
cudaError_t cudaGetDeviceCount(int *);
cudaError_t cudaGetLastError(void);
cudaError_t cudaDeviceSynchronize(void);
const char * cudaGetErrorString(cudaError_t);
struct dim3 { unsigned x,y,z; dim3(unsigned X=1,unsigned Y=1,unsigned Z=1):x(X),y(Y),z(Z){} };
#define __global__
#define __device__
#define __host__
#define __forceinline__ inline
#define __restrict__
#define __half2float(x) ((float)(x))
#define __float2half(x) ((unsigned short)(x))
#define __shfl_xor_sync(m,v,d) (v)
struct __bI { unsigned x,y,z; }; struct __tI { unsigned x,y,z; };
static __bI blockIdx; static __tI threadIdx;
