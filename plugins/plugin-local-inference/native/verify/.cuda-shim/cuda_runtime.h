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
#ifndef __global__
#define __global__
#endif
#ifndef __device__
#define __device__
#endif
#ifndef __host__
#define __host__
#endif
#ifndef __forceinline__
#define __forceinline__ inline
#endif
#define __shfl_xor_sync(m,v,d) (v)
#define __shfl_sync(m,v,s) (v)
#define __syncthreads()
#define __syncwarp()
struct __bI { unsigned x,y,z; }; struct __tI { unsigned x,y,z; };
static __bI blockIdx; static __tI threadIdx;
static __bI blockDim;  static __bI gridDim;
