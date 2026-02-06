import React, { memo } from "react";
import styled, { css } from "styled-components";

const StyledRound = styled.div`
  ${({ radius }) => css`
    border-radius: 100%;
    width: ${radius}px;
    height: ${radius}px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: rgba(60, 64, 67, 0.3) 0px 1px 2px 0px,
      rgba(60, 64, 67, 0.15) 0px 1px 3px 1px;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
    & svg {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
    }
    & span {
      z-index: 0;
    }
  `}
`;

const Round = ({
  size = 50,
  radius = isNaN(size) ? 50 : size,
  color = "#ccc",
  flippedColor = "#ccc",
  flipped = false,
  text = "",
  textColor = "#000",
  fontSize = "16",
}) => {
  return (
    <StyledRound radius={radius}>
      <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <circle
          cx="50"
          cy="50"
          r="50"
          style={{
            fill: flipped ? flippedColor : color,
          }}
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
    </StyledRound>
  );
};

export default memo(Round);
