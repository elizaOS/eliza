export function computePca(data: number[][], dims = 2): number[][] {
  if (data.length === 0) return [];
  const dim = data[0].length;
  const mean = Array(dim).fill(0);
  for (const vec of data) {
    for (let i = 0; i < dim; i++) mean[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= data.length;
  const centered = data.map((v) => v.map((val, idx) => val - mean[idx]));
  // covariance matrix
  const cov = Array.from({ length: dim }, () => Array(dim).fill(0));
  for (const vec of centered) {
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        cov[i][j] += vec[i] * vec[j];
      }
    }
  }
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      cov[i][j] /= data.length - 1;
    }
  }
  const eigenvectors: number[][] = [];
  let matrix = cov.map((row) => row.slice());
  for (let k = 0; k < dims; k++) {
    // start with a deterministic unit vector for stability
    let vec = Array(dim).fill(1 / Math.sqrt(dim));
    for (let iter = 0; iter < 50; iter++) {
      const next = multiplyMatrixVector(matrix, vec);
      const norm = Math.sqrt(next.reduce((a, b) => a + b * b, 0));
      if (norm === 0) break;
      vec = next.map((v) => v / norm);
    }
    eigenvectors.push(vec.slice());
    const lambda = dot(vec, multiplyMatrixVector(matrix, vec));
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        matrix[i][j] -= lambda * vec[i] * vec[j];
      }
    }
  }
  return centered.map((vec) => eigenvectors.map((ev) => dot(vec, ev)));
}

function multiplyMatrixVector(mat: number[][], vec: number[]): number[] {
  return mat.map((row) => row.reduce((sum, val, i) => sum + val * vec[i], 0));
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, val, i) => sum + val * b[i], 0);
}
