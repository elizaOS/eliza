import React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { useMessage } from "react-sync-board";
import { FiMessageSquare } from "react-icons/fi";

import useNotify from "../hooks/useNotify";
import NavButton from "../ui/NavButton";
import SidePanel from "../ui/SidePanel";

import Composer from "./Composer";
import MessageList from "./MessageList";

const StyledChat = styled.div`
  height: 100%;
  display: flex;
  flex-direction: column;
`;

const NotifCount = styled.div`
  width: 2em;
  height: 2em;
  border-radius: 100%;
  position: absolute;
  top: -5px;
  right: 1.8em;
  background-color: var(--color-success);
  text-align: center;
  line-height: 2em;
  box-shadow: 3px 3px 6px #000000c0;
`;

export const MessagePanel = ({ onNewMessage, show, setShow }) => {
  const { t } = useTranslation();
  const { messages, sendMessage } = useMessage(onNewMessage);

  return (
    <SidePanel
      open={show}
      onClose={() => {
        setShow(false);
      }}
      position="right"
      noMargin
      title={t("Chat")}
    >
      <StyledChat>
        <MessageList messages={messages} />
        <Composer sendMessage={sendMessage} />
      </StyledChat>
    </SidePanel>
  );
};

export const MessageButton = () => {
  const { t } = useTranslation();
  const { add, reset, count } = useNotify();
  const [showPanel, setShowPanel] = React.useState(false);
  const showPanelRef = React.useRef(false);

  const setShowPanelRef = React.useCallback(
    (value) => {
      setShowPanel(value);
      showPanelRef.current = value;
      if (value) {
        reset();
      }
    },
    [reset]
  );

  const onNewMessage = React.useCallback(() => {
    if (!showPanelRef.current) {
      add();
    }
  }, [add]);

  React.useEffect(() => {
    reset();
  }, [reset]);

  const countStr = count > 9 ? "9+" : `${count}`;

  return (
    <>
      <div style={{ position: "relative" }}>
        <NavButton
          onClick={() => setShowPanelRef(!showPanelRef.current)}
          alt={t("Chat")}
          title={t("Chat")}
          Icon={FiMessageSquare}
        />
        {count > 0 && <NotifCount>{countStr}</NotifCount>}
      </div>
      <MessagePanel
        onNewMessage={onNewMessage}
        show={showPanel}
        setShow={setShowPanelRef}
      />
    </>
  );
};

export default MessageButton;
