import React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";

const StyledComposer = styled.div`
  padding: 0.5em;
  flex: 0;
  & form {
    display: flex;
  }
  overflow: none;
`;

const Composer = ({ sendMessage }) => {
  const { t } = useTranslation();
  const [text, setText] = React.useState("");

  const onSubmit = (e) => {
    e.preventDefault();
    if (text) {
      setText("");
      sendMessage(text);
    }
  };
  const onChange = (e) => {
    setText(e.target.value);
  };
  return (
    <StyledComposer>
      <form onSubmit={(e) => onSubmit(e)}>
        <input
          onChange={(e) => onChange(e)}
          value={text}
          type="text"
          placeholder={t("Enter your message and press ENTER")}
          autoFocus={true}
        />
        <button>{t("Send")}</button>
      </form>
    </StyledComposer>
  );
};

export default Composer;
