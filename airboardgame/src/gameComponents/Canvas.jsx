import React, { useState } from "react";
import styled from "styled-components";

import { useAsync } from "@react-hookz/web/esm/useAsync";
import useAsyncEffect from "use-async-effect";
import { getImage } from "../utils/image";

const defaultSize = 50;

const paint = async ({
  canvas,
  width: givenWidth,
  height: givenHeight,
  layers,
}) => {
  if (canvas) {
    const context = canvas.getContext("2d");

    // Load all images
    const images = await Promise.all(layers.map(({ url }) => getImage(url)));

    const firstImage = images.find((image) => image);

    const firstImageDim = {};
    firstImageDim.width = firstImage?.width || defaultSize;
    firstImageDim.height = firstImage?.height || defaultSize;

    let width, height;
    let ratioWidth = 1,
      ratioHeight = 1;

    if (isNaN(givenWidth) && isNaN(givenHeight)) {
      width = firstImageDim.width;
      height = firstImageDim.height;
    } else if (isNaN(givenWidth)) {
      // Height is set
      height = givenHeight;
      ratioHeight = ratioWidth = givenHeight / firstImageDim.height;
      width = ratioWidth * firstImageDim.width;
    } else if (isNaN(givenHeight)) {
      width = givenWidth;
      ratioWidth = ratioHeight = givenWidth / firstImageDim.width;
      height = ratioHeight * firstImageDim.height;
    } else {
      ratioWidth = givenWidth / firstImageDim.width;
      ratioHeight = givenHeight / firstImageDim.height;
      width = firstImageDim.width * ratioWidth;
      height = firstImageDim.height * ratioHeight;
    }

    const originalHeigh = firstImageDim.height;
    const originalWidth = firstImageDim.width;

    canvas.width = originalWidth;
    canvas.height = originalHeigh;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";

    const center = { x: originalWidth / 2, y: originalHeigh / 2 };

    // Clear canvas
    context.clearRect(0, 0, originalWidth, originalHeigh);

    // Draw layers
    layers.forEach(({ offsetX = 0, offsetY = 0 }, index) => {
      const image = images[index];
      if (image) {
        if (index === 0) {
          // Draw main image
          context.drawImage(image, 0, 0, originalWidth, originalHeigh);
        } else {
          const { width: w, height: h } = image;
          const [halfWidth, halfHeight] = [w / 2, h / 2];
          context.drawImage(
            image,
            center.x - halfWidth + offsetX,
            center.y - halfHeight + offsetY,
            w,
            h
          );
        }
      }
    });
  }
};

const Canvas = ({ width, height, layers }) => {
  const [refreshed, setRefreshed] = useState(false);
  const canvasRef = React.useRef(null);

  useAsyncEffect(async () => {
    await paint({
      canvas: canvasRef.current,
      width,
      height,
      layers,
    });
    if (!refreshed) {
      // Force a refresh a few seconds after the first paint.
      // Somehow it's not displaying in Firefox in some situations when using external
      // images.
      setTimeout(() => {
        setRefreshed(true);
      }, 1000);
    }
  }, [layers, height, width, refreshed]);

  return <canvas ref={canvasRef}></canvas>;
};

const ImageElm = styled.img`
  display: block;
  pointer-events: none;
`;

const ImageWrapper = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: center;
  align-items: center;
`;

const Error = styled.div`
  min-width: 50px;
  min-height: 50px;
  &:after {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    content: "\\274c";
    font-size: 25px;
    color: #fff;
    line-height: 50px;
    text-align: center;
  }
`;

const Loading = styled.div`
  background: transparent;
  background: linear-gradient(
    90deg,
    transparent 8%,
    #f5f5f53d 18%,
    transparent 33%
  );
  background-size: 200% 100%;
  animation: 2s shine linear infinite;
  min-width: 50px;
  min-height: 50px;
`;

const NoCanvas = ({ layers, width, height }) => {
  const [firstImage, ...rest] = layers;

  const [state, actions] = useAsync(async () => {
    await getImage(firstImage.url);
    return true;
  }, false);

  React.useEffect(() => {
    if (firstImage.url) {
      actions.reset();
      actions.execute();
    }
  }, [actions, firstImage.url]);

  if (state.status === "error") {
    return <Error />;
  }

  if (state.status === "loading") {
    return <Loading />;
  }

  return (
    <div style={{ position: "relative" }}>
      {firstImage && (
        <ImageElm
          src={firstImage.url}
          alt=""
          onError={(e) => (e.target.src = "/default.png")}
          draggable={false}
          width={width}
          height={height}
        />
      )}
      {rest.map(({ url, offsetX = 0, offsetY = 0 }) => {
        return (
          <ImageWrapper key={url}>
            <ImageElm
              src={url}
              onError={(e) => (e.target.src = "/default.png")}
              alt=""
              draggable={false}
              style={{ marginLeft: offsetX * 2, marginTop: offsetY * 2 }}
            />
          </ImageWrapper>
        );
      })}
    </div>
  );
};

const ChooseCanvas = ({ useCanvas = false, ...rest }) => {
  if (useCanvas) {
    return <Canvas {...rest} />;
  } else {
    return <NoCanvas {...rest} />;
  }
};

export default ChooseCanvas;
