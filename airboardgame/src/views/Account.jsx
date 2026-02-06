import React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import Modal from "../ui/Modal";
import { sendAuthToken } from "../utils/api";
import useAuth from "../hooks/useAuth";

import Waiter from "../ui/Waiter";

const Account = ({ disabled, ...props }) => {
  const { t } = useTranslation();
  const { isAuthenticated, logout } = useAuth();
  const [email, setEmail] = React.useState("");
  const [emailSent, setEmailSent] = React.useState(false);
  const [showLogin, setShowLogin] = React.useState(false);
  const [loginInProgress, setLoginInProgress] = React.useState(false);

  const handleChange = (e) => {
    setEmail(e.target.value);
  };

  const handleSubmit = async () => {
    try {
      setLoginInProgress(true);
      await sendAuthToken(email);
      setEmailSent(true);
      setLoginInProgress(false);
    } catch (e) {
      setLoginInProgress(false);
      console.log(e);
      toast.error(t("Error while logging, verify your email address"));
    }
  };

  const showAlert = () => {
    alert(t("Cookie are disabled or not yet accepted, can't connect"));
  };

  React.useEffect(() => {
    if (!showLogin) {
      setEmail("");
      setEmailSent(false);
    }
  }, [showLogin]);

  if (disabled) {
    return (
      <div {...props}>
        <button
          onClick={showAlert}
          title={t("Cookie are disabled or not yet accepted, can't connect")}
          style={{ opacity: 0.4, cursor: "not-allowed" }}
        >
          {t("Login")}
        </button>
      </div>
    );
  }

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      handleSubmit();
    }
  };

  return (
    <>
      <div {...props}>
        {isAuthenticated ? (
          <button onClick={logout}>{t("Logout")}</button>
        ) : (
          <button onClick={() => setShowLogin(true)}>{t("Login")}</button>
        )}
      </div>
      {loginInProgress && <Waiter message={t("In progress...")} />}

      <Modal
        show={!emailSent && showLogin}
        setShow={setShowLogin}
        title={t("Login")}
        width="33%"
      >
        <input
          value={email}
          onChange={handleChange}
          placeholder={t("Enter your email here")}
          onKeyDown={handleKeyDown}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginTop: "2em",
          }}
        >
          <button onClick={handleSubmit} className="button success">
            {t("Ask authentication link")}
          </button>
        </div>
      </Modal>

      {emailSent && (
        <Modal
          show={showLogin}
          setShow={setShowLogin}
          title={t("Login")}
          width="33%"
        >
          <p>{t("Mail sent, check your inbox and click the link to login.")}</p>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              marginTop: "2em",
            }}
          >
            <button
              className="button success"
              onClick={() => setShowLogin(false)}
            >
              Ok
            </button>
          </div>
        </Modal>
      )}
    </>
  );
};

export default Account;
