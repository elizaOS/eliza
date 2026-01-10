declare module 'canvas' {
  export class Canvas {
    constructor(width: number, height: number);
    getContext(contextType: '2d'): CanvasRenderingContext2D;
    width: number;
    height: number;
  }

  export class Image {
    src: string;
    width: number;
    height: number;
    onload: () => void;
    onerror: (err: Error) => void;
  }

  export class ImageData {
    constructor(data: Uint8ClampedArray, width: number, height: number);
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }

  interface CanvasRenderingContext2D {
    putImageData(imageData: ImageData, x: number, y: number): void;
    getImageData(x: number, y: number, width: number, height: number): ImageData;
    drawImage(image: Image, x: number, y: number): void;
  }
}
