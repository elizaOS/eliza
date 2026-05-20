declare module "onnxruntime-node" {
	export type TensorData =
		| Float32Array
		| Float64Array
		| BigInt64Array
		| BigUint64Array
		| Int32Array
		| number[]
		| bigint[];

	export class Tensor {
		constructor(type: string, data: TensorData, dims?: readonly number[]);
		type: string;
		data: TensorData;
		dims: number[];
	}

	export interface InferenceSession {
		outputNames: string[];
		run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
	}
}
