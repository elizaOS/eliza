import React, { memo, useEffect } from "react";
import styled, { css } from "styled-components";
import { lighten } from "color2k";

import { randInt } from "../../utils";

const NotePane = styled.div`
  ${({ color, fontSize, textColor, width, height, fontFamily, rotate }) => css`
    background: linear-gradient(${color}, ${lighten(color, 0.1)});
    width: ${width}px;
    padding: 0.5em;
    text-align: center;
    display: flex;
    justify-content: space-between;
    flex-direction: column;
    box-shadow: 2px 9px 10px 3px rgba(0,0,0,0.2);
    color: ${textColor};
    transform: rotate(${rotate}deg) skew(0);
    z-index: 2;

    border-bottom-right-radius: 50% 1%;
    border-top-left-radius: 50% 1%;

    .item-library__component & {
      background-color: #ccc;
    }

    & .note__title {
      min-height: 2em;
      font-family: "${fontFamily}", sans-serif;
      font-weight: bold;
      padding: 0.2em 0;
      margin: 0;

      .item-library__component & {
        min-height: auto;
      }
    }

    & .note__textarea {
      color: ${textColor};
      font-family: "${fontFamily}", sans-serif;

      &:focus{
        outline: none;
        box-shadow: none;
      }

      height: ${height}px;
      width: 100%;
      padding: 0.3em;
      background-color: transparent;
      resize: none;
      border: none;
      font-size: ${fontSize}px;
      border-radius: 1px;

      .item-library__component & {
        height: 35px;
      }
    }
  `}
`;

const stopPropagationIfActive = (e) =>
  e.target === document.activeElement && e.stopPropagation();

const Note = ({
  value = "",
  color = "#FFEC27",
  label = "",
  textColor = "#000",
  fontFamily = "Roboto",
  fontSize = 20,
  width = 300,
  height = 200,
  setState,
}) => {
  // To avoid this behavior https://github.com/facebook/react/issues/955
  // We have a local state and a use effect when incoming update occurs
  const [currentValue, setCurrentValue] = React.useState(value);
  const [rotate] = React.useState(() => (randInt(5, 15) - 10) / 5);

  const setValue = (e) => {
    const value = e.target.value;
    setCurrentValue(value);
    setState((prevState) => ({
      ...prevState,
      value,
    }));
  };

  useEffect(() => {
    setCurrentValue(value);
  }, [value]);

  return (
    <NotePane
      color={color}
      fontSize={fontSize}
      textColor={textColor}
      fontFamily={fontFamily}
      width={width}
      height={height}
      onKeyDown={stopPropagationIfActive}
      onKeyUp={stopPropagationIfActive}
      onWheel={stopPropagationIfActive}
      onPointerMove={stopPropagationIfActive}
      rotate={rotate}
    >
      <label style={{ userSelect: "none" }}>
        <h3 className="note__title">{label}</h3>
        <textarea
          className="note__textarea"
          value={currentValue}
          onChange={setValue}
        />
      </label>
    </NotePane>
  );
};

export default memo(Note);
