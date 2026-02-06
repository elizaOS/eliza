const callAnother = () => {
  console.log("Foo");
};

const main = async ({ query, body, test, store }) => {
  callAnother();
  console.log("Received params", query, body, test);

  //console.log(await store.create("games", { name: "toto" }));
  console.log(await store.list("youpla", {}));

  return 42;
};

export default main;
