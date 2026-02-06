import React from "react";
import styled, { keyframes } from "styled-components";

const spin = keyframes`
100% {
  transform: rotate(360deg);
}
`;

const StyledSpinner = styled.div`
  animation: ${spin} 1s infinite linear;
  border: solid ${({ size }) => size / 10}px transparent;
  border-radius: 50%;
  border-right-color: var(--color-primary);
  border-top-color: var(--color-primary);
  box-sizing: border-box;
  height: ${({ size }) => size}px;
  width: ${({ size }) => size}px;
  margin: 0 auto;
  z-index: 1;
  &:before {
    animation: ${spin} 2s infinite linear;
    border: solid ${({ size }) => size / 10}px transparent;
    border-radius: 50%;
    border-right-color: var(--color-primary);
    border-top-color: var(--color-primary);
    box-sizing: border-box;
    content: "";
    height: ${({ size }) => size - (2 * size) / 10}px;
    width: ${({ size }) => size - (2 * size) / 10}px;
    position: absolute;
    top: 0;
    left: 0;
  }
  &:after {
    animation: ${spin} 3s infinite linear;
    border: solid ${({ size }) => size / 10}px transparent;
    border-radius: 50%;
    border-right-color: var(--color-primary);
    border-top-color: var(--color-primary);
    box-sizing: border-box;
    content: "";
    height: ${({ size }) => size - (4 * size) / 10}px;
    width: ${({ size }) => size - (4 * size) / 10}px;
    position: absolute;
    top: ${({ size }) => size / 10}px;
    left: ${({ size }) => size / 10}px;
  }
`;

const Spinner = ({ size = 100 }) => <StyledSpinner size={size} />;

export default Spinner;
