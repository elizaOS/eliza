import React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { toast } from "react-toastify";

import Modal from "../../ui/Modal";

import GameInformation from "./GameInformation";
import { FiCopy } from "react-icons/fi";

const StyledUrl = styled.div`
  background-color: var(--color-midGrey);
  padding: 0.5em;
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2em;

  & span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  & svg {
    margin-left: 1em;
    cursor: pointer;
  }
`;

const WelcomeModal = ({ show, setShow, welcome = true }) => {
  const { t } = useTranslation();
  const currentUrl = window.location.href;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.info(t("Url copied to clipboard!"), { autoClose: 1000 });
    } catch (e) {
      toast.info(t("You don't have the permissions to copy the Url"), {
        autoClose: 1000,
      });
    }
  };

  return (
    <Modal
      title={welcome ? t("Ready to play ?") : t("Invite more player")}
      setShow={setShow}
      show={show}
    >
      <header>
        <h3>{t("Share this link with your friends")}</h3>
      </header>
      <section>
        <StyledUrl>
          <span>{currentUrl}</span>
          <FiCopy
            className="copy"
            alt={t("Copy")}
            onClick={handleCopy}
            size="22"
            color="#888886"
          />
        </StyledUrl>
        <p>
          {t(
            "Share this link with your friends and start playing immediately."
          )}
        </p>

        {welcome && (
          <button
            onClick={() => {
              setShow(false);
            }}
            className="button success"
            style={{ margin: "1em auto" }}
          >
            {t("I want to play...")}
          </button>
        )}
      </section>
      {welcome && <GameInformation />}
    </Modal>
  );
};

export default WelcomeModal;
