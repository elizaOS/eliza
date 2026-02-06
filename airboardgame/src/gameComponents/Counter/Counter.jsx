import React, { memo } from "react";
import styled, { css } from "styled-components";

const CounterPane = styled.div`
  ${({ color }) => css`
    background-color: ${color};
    padding: 0.5em;
    text-align: center;
    border-radius: 3px;
    box-shadow: 4px 4px 5px 0px rgb(0, 0, 0, 0.3);

    .item-library__component & {
      transform: scale(0.7);
    }

    .counter-content {
      display: flex;
      justify-content: space-between;
      align-items: stretch;
    }

    button {
      padding: 1rem;
      margin: 0;
      border: none;
      min-width: 40px;
      font-size: 1.2em;
      flex: 1;
    }

    input {
      user-select: none;
      text-align: center;
      width: 3em !important;
      border-radius: 0 !important;
      border: none !important;
      margin: 0 -1px;
      flex: 5;
    }

    h3 {
      line-height: 1em;
      user-select: none;
      padding: 0;
      padding-bottom: 0.5em;
      margin: 0;
    }
  `}
`;

const Counter = ({
  value = 0,
  color = "#CCC",
  label = "",
  textColor = "#000",
  fontSize = 22,
  setState,
}) => {
  const setValue = (e) => {
    let value = parseInt(e.target.value, 10);
    if (isNaN(value)) {
      value = 0;
    }

    setState((prevState) => ({
      ...prevState,
      value: value,
    }));
  };

  const increment = (e) => {
    e.stopPropagation();
    setState((prevState) => ({
      ...prevState,
      value: (prevState.value || 0) + 1,
    }));
  };

  const decrement = (e) => {
    e.stopPropagation;
    setState((prevState) => ({
      ...prevState,
      value: (prevState.value || 0) - 1,
    }));
  };

  return (
    <CounterPane color={color}>
      {label && <h3>{label}</h3>}
      <div className="counter-content">
        <button
          onClick={decrement}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{ borderRadius: "2px 0 0 2px" }}
        >
          -
        </button>
        <input
          style={{
            color: textColor,
            fontSize: fontSize + "px",
          }}
          onKeyUp={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          value={value}
          onChange={setValue}
        />
        <button
          onClick={increment}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{ borderRadius: "0 2px 2px 0" }}
        >
          +
        </button>
      </div>
    </CounterPane>
  );
};

export default memo(Counter);
