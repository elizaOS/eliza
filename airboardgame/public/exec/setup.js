const main = ({ store }) => {
  store.createOrUpdateBox("game", { security: "readOnly" });
  console.log("Setup loaded");
  return {};
};
