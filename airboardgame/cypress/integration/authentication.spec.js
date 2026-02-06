describe("Authentication", () => {
  beforeEach(() => {
    cy.viewport(1000, 600);
    cy.intercept(
      {
        method: "GET",
        url: "/airboardgame/store/game*",
      },
      "[]"
    );
    cy.visit("/");
  });

  it("Can see Log in button", () => {
    cy.contains("Log in");
  });

  it("Can ask to log in", () => {
    cy.intercept(
      {
        method: "POST",
        url: "/airboardgame/auth/",
      },
      (req) => {
        expect(req.body).to.deep.equal({ userEmail: "test@fake.fr" });
        req.reply(req.body);
      }
    );

    cy.contains("Log in").click();
    cy.get(".modal input").type("test@fake.fr");

    cy.contains("Ask an authentication link").click();

    cy.contains("Mail sent");
    cy.contains("Ok").click();

    cy.contains("Mail sent").should("not.exist");
  });

  it("Can verify login", () => {
    cy.intercept(
      {
        method: "GET",
        url: "/airboardgame/auth/verify/titi/toto",
      },
      (req) => {
        req.reply("Ok");
      }
    );
    cy.intercept(
      {
        method: "GET",
        url: "/airboardgame/auth/check",
      },
      // eslint-disable-next-line quotes
      '{"message":"success"}'
    );

    cy.visit("/login/titi/toto");

    cy.contains("Studio");
  });
});
