import React, { memo } from "react";
import styled, { css } from "styled-components";
import { useTranslation } from "react-i18next";

import useGameItemActions from "../useGameItemActions";

const DicePane = styled.div`
  ${({ color }) => css`
    background-color: ${color};
    padding: 0.3em;
    text-align: center;
    display: flex;
    justify-content: space-between;
    flex-direction: column;
    align-items: center;
    border-radius: 2px;
    box-shadow: 3px 3px 8px 0px rgb(0, 0, 0, 0.3);

    & h3 {
      user-select: none;
      padding: 0;
      margin: 0;
      line-height: 1em;
    }

    .item-library__component & {
      transform: scale(0.8);
    }

    & .result {
      line-height: 1em;
      display: block;
      border: none;
      padding: 0.2em;
      user-select: none;
    }
  `}
`;

const Dice = ({
  value = 0,
  color = "#CCC",
  label = "",
  textColor = "#fff",
  fontSize = "35",
  id,
}) => {
  const { t } = useTranslation();
  const { roll } = useGameItemActions();

  return (
    <div>
      <DicePane color={color}>
        <h3>{label}</h3>
        <span
          style={{
            color: textColor,
            fontSize: fontSize + "px",
          }}
          className="result"
        >
          {value + 1}
        </span>
        <span>
          <button
            onClick={() => roll([id])}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {t("Roll")}
          </button>
        </span>
      </DicePane>
    </div>
  );
};

export default memo(Dice);
