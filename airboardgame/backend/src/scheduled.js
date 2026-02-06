const SESSION_DURATION = 60; // Session duration in days

export const deleteOldSession = (store) => async () => {
  const boxId = "session";
  const sessions = await store.list(boxId, { limit: 10000 });
  sessions.forEach(async (session) => {
    const now = Date.now();
    if (!session.timestamp) {
      console.log("Delete session without timestamp ", session._id);
      await store.delete(boxId, session._id);
    }
    if (now - session.timestamp > SESSION_DURATION * 24 * 60 * 60 * 1000) {
      console.log("Delete too old session ", session._id);
      await store.delete(boxId, session._id);
    }
  });
};
