import React from "react";
import { SketchPicker } from "react-color";
import { useTranslation } from "react-i18next";
import styled from "styled-components";

import Modal from "../ui/Modal";

import UserCircle from "./UserCircle";

const StyledInputName = styled.input`
  &:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="color"]):not([type="button"]):not([type="reset"]) {
    width: 12em;
  }
`;

const emptyStyle = {};
const emptyColors = [];

const UserConfig = ({ user, updateCurrentUser, editable, index }) => {
  const { t } = useTranslation();

  const [name, setName] = React.useState(user.name);
  const [color, setColor] = React.useState(user.color);
  const [showDetails, setShowDetails] = React.useState(false);

  const handleChange = React.useCallback(
    (e) => {
      setName(e.target.value);
      updateCurrentUser({ name: e.target.value });
    },
    [updateCurrentUser]
  );

  const handleChangecolor = React.useCallback((newColor) => {
    setColor(newColor.hex);
  }, []);

  const handleChangecolorComplete = React.useCallback(
    (newColor) => {
      setColor(newColor.hex);
      updateCurrentUser({ color: newColor.hex });
    },
    [updateCurrentUser]
  );

  return (
    <>
      <UserCircle
        color={user.color}
        onClick={() => editable && setShowDetails(true)}
        title={user.name}
        name={user.name || `${index}`}
        isSelf={editable}
      />
      <Modal
        title={t("User details")}
        show={showDetails}
        setShow={setShowDetails}
      >
        <label>{t("Username")}</label>
        <StyledInputName value={name} onChange={handleChange} />

        <label>{t("Color")}</label>
        <SketchPicker
          disableAlpha
          presetColors={emptyColors}
          color={color}
          onChange={handleChangecolor}
          onChangeComplete={handleChangecolorComplete}
          styles={emptyStyle}
          width={160}
        />
      </Modal>
    </>
  );
};

export default UserConfig;
