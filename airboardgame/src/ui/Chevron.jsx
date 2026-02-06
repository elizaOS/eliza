import React from "react";
import styled from "styled-components";

const StyledChevron = styled.span`
  position: relative;
  display: inline-block;
  ${({ orientation, color }) => {
    switch (orientation) {
      case "top":
      case "bottom":
        return `border-color: ${color} transparent;`;
      default:
        return `border-color: transparent ${color};`;
    }
  }}
  border-style: solid;
  ${({ orientation, size }) => {
    switch (orientation) {
      case "top":
        return `border-width: 0 ${size / 2}px  ${size}px ${size / 2}px;`;
      case "bottom":
        return `border-width: ${size}px ${size / 2}px 0 ${size / 2}px;`;
      case "left":
        return `border-width: ${size / 2}px ${size}px ${size / 2}px 0;`;
      default:
        return `border-width: ${size / 2}px 0 ${size / 2}px ${size}px;`;
    }
  }}
`;

const Chevron = ({ size = 14, orientation = "right", color = "#fff" }) => (
  <StyledChevron size={size} orientation={orientation} color={color} />
);

export default Chevron;
