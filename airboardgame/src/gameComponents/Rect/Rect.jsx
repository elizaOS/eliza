import React, { memo } from "react";
import styled, { css } from "styled-components";

const StyledShape = styled.div`
  ${({ width, height, color }) => css`
    width: ${width}px;
    height: ${height}px;*
    box-shadow: rgba(60, 64, 67, 0.3) 0px 1px 2px 0px,
      rgba(60, 64, 67, 0.15) 0px 1px 3px 1px;
    background-color: ${color};

    display: flex;
    justify-content: center;
    align-items: center;
    & span {
      z-index: 0;
    }
  `}
`;

const Rect = ({
  width = 50,
  height = 50,
  color = "#ccc",
  flippedColor = "#ccc",
  flipped = false,
  text = "",
  textColor = "#000",
  fontSize = 16,
}) => {
  return (
    <StyledShape
      width={width}
      height={height}
      color={flipped ? flippedColor : color}
    >
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
    </StyledShape>
  );
};

export default memo(Rect);
