import btoa from "btoa";
import fetch from "node-fetch";

const OPENVIDU_SERVER_URL = process.env.OPENVIDU_URL;
const OPENVIDU_SERVER_SECRET = process.env.OPENVIDU_SECRET;

const createSession = (sessionId) => {
  return new Promise((resolve, reject) => {
    fetch(`${OPENVIDU_SERVER_URL}/openvidu/api/sessions`, {
      method: "POST",
      body: JSON.stringify({ customSessionId: sessionId }),
      headers: {
        Authorization: "Basic " + btoa(`OPENVIDUAPP:${OPENVIDU_SERVER_SECRET}`),
        "Content-Type": "application/json",
      },
    })
      .then((response) => {
        if (response.status === 409) {
          resolve(sessionId);
        } else {
          response.json().then((data) => {
            resolve(data.id);
          });
        }
      })
      .catch((error) => {
        console.warn(
          "No connection to OpenVidu Server. This may be a certificate error at " +
            OPENVIDU_SERVER_URL
        );
        reject(error);
      });
  });
};

const createToken = (sessionId) => {
  return fetch(
    `${OPENVIDU_SERVER_URL}/openvidu/api/sessions/${sessionId}/connection`,
    {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        Authorization: "Basic " + btoa(`OPENVIDUAPP:${OPENVIDU_SERVER_SECRET}`),
        "Content-Type": "application/json",
      },
    }
  )
    .then((response) => {
      return response.json();
    })
    .then((data) => {
      return data.token;
    });
};

const getConfToken = ({ query }) => {
  const { session } = query;
  return createSession(session).then((sessionId) => createToken(sessionId));
};

export default getConfToken;
