import React, { memo } from "react";
import styled, { css } from "styled-components";

const StyledHexagon = styled.div`
  ${({ size, vertical }) => css`
    width: ${vertical ? 0.866025 * size : size}px;
    height: ${vertical ? size : 0.866025 * size}px;
    display: flex;
    align-items: center;
    justify-content: center;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
    & svg {
      transform-origin: center center;
      ${vertical ? "transform: rotate(30deg);" : ""}
      position: absolute;
      top: ${vertical ? (0.133975 * size) / 2 + "px" : "0"};
      left: ${vertical ? (-0.133975 * size) / 2 + "px" : "0"};
      width: ${size}px;
      height: ${0.866025 * size}px;
    }
    & span {
      z-index: 0;
    }
  `}
`;

const Hexagon = ({
  size = 50,
  color = "#ccc",
  flippedColor = "#ccc",
  flipped = false,
  text = "",
  textColor = "#000",
  fontSize = "16",
  vertical = false,
}) => {
  return (
    <StyledHexagon size={size} vertical={vertical}>
      <svg
        version="1.1"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 723 626"
      >
        <polygon
          points="723,314 543,625.769145 183,625.769145 3,314 183,2.230855 543,2.230855 723,314"
          fill={flipped ? flippedColor : color}
        />
      </svg>
      {text && (
        <span
          style={{
            color: textColor,
            fontSize: fontSize + "px",
          }}
        >
          {text}
        </span>
      )}
    </StyledHexagon>
  );
};

export default memo(Hexagon);
