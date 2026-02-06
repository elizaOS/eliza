import React from "react";
import { memo } from "react";
import styled, { css } from "styled-components";
import { useUsers } from "react-sync-board";
import { useTranslation } from "react-i18next";
import { readableColor, lighten } from "color2k";

const ScreenWrapper = styled.div`
  ${({
    width = 200,
    height = 200,
    borderColor = "#cccccc33",
    borderStyle = "solid",
    backgroundColor = "#ccc",
    owned = false,
  }) => css`
    width: ${width}px;
    height: ${height}px;
    ${owned ? `border: 2px ${borderStyle} ${borderColor};` : ""}
    border-radius: 5px;
    position: relative;
    color: ${readableColor(backgroundColor)};

    .screen__release-button {
      position: absolute;
      bottom: -48px;
      left: 0;
    }

    .screen__claim-button {
      .item-library__component & {
        display: none;
      }
    }

    .screen__visible-message,
    .screen__claimed-message {
      width: 80%;
      text-align: center;

      .item-library__component & {
        display: none;
      }
    }

    .screen__overlay {
      position: absolute;
      inset: 0;
      ${owned
        ? ""
        : `background-image: radial-gradient(${lighten(
            backgroundColor,
            0.2
          )}, ${backgroundColor});`}
      display: flex;
      justify-content: center;
      align-items: center;
      flex-direction: column;
      border-radius: 5px;
    }
  `}
`;

const Screen = ({
  width,
  height,
  borderColor,
  borderStyle,
  backgroundColor,
  ownedBy,
  setState,
}) => {
  const { t } = useTranslation();
  const { currentUser, localUsers: users } = useUsers();

  const ownedByUser = React.useMemo(() => {
    if (Array.isArray(ownedBy)) {
      const result = ownedBy
        .filter((userId) => users.find(({ uid }) => userId === uid))
        .map((userId) => users.find(({ uid }) => userId === uid));
      if (result.length > 0) {
        return result[0];
      }
    }
    return null;
  }, [ownedBy, users]);

  const ownedByMe = ownedByUser?.uid === currentUser.uid;

  const claimIt = React.useCallback(
    (e) => {
      e.stopPropagation();
      setState((prev) => {
        let ownedBy = Array.isArray(prev.ownedBy) ? prev.ownedBy : [];

        if (!ownedBy.includes(currentUser.uid)) {
          ownedBy = [currentUser.uid];
        } else {
          ownedBy = ownedBy.filter((id) => id !== currentUser.uid);
        }
        return {
          ...prev,
          ownedBy,
        };
      });
    },
    [currentUser.uid, setState]
  );

  return (
    <ScreenWrapper
      width={width}
      height={height}
      borderStyle={borderStyle}
      borderColor={borderColor}
      backgroundColor={backgroundColor}
      owned={ownedByMe}
    >
      <div className="screen__overlay">
        {!ownedByUser && (
          <>
            <button className="screen__claim-button" onClick={claimIt}>
              {t("Claim it")}
            </button>
            <div className="screen__visible-message">
              {t(
                "If you claim this screen, everything inside this zone will be hidden from other players."
              )}
            </div>
          </>
        )}
        {ownedByUser && !ownedByMe && (
          <div className="screen__claimed-message">
            {t("This screen is owned by {{name}}", ownedByUser)}
          </div>
        )}
      </div>
      {ownedByMe && (
        <button className="screen__release-button" onClick={claimIt}>
          {t("Release it")}
        </button>
      )}
    </ScreenWrapper>
  );
};

export default memo(Screen);
