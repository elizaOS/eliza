declare global {
  type AudioWorkletInputs = Float32Array[][]

  var AudioWorkletProcessor: new () => { readonly port: MessagePort }

  function registerProcessor(
    name: string,
    processor: new () => InstanceType<typeof AudioWorkletProcessor> & {
      process(inputs: AudioWorkletInputs): boolean
    },
  ): void
}

export {}
