const callAnother = () => {
  console.log("Foo");
};

const main = async () => {
  callAnother();
  console.log("Received params", query, body, test);

  //console.log(await store.create("games", { name: "toto" }));
  console.log(await store.list("games", {}));

  return 42;
};
