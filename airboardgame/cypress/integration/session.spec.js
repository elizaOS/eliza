describe("Session management", () => {
  beforeEach(() => {
    cy.viewport(1000, 600);
    cy.intercept(
      {
        method: "GET",
        url: "/airboardgame/store/game*",
      },
      // eslint-disable-next-line quotes
      "[]"
    );

    cy.visit("/");

    cy.contains("0 Test game", { timeout: 10000 })
      .parent()
      .find(".img-wrapper")
      .click();

    // Way board loading
    cy.get(".board-pane", { timeout: 10000 }).should(
      "have.css",
      "transform",
      "matrix(0.24, 0, 0, 0.24, -5596.48, -5808.48)"
    );
    cy.get(".item")
      .first()
      .children()
      .first()
      .should("have.css", "transform", "none");
  });

  it("should autosave session", () => {
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .parent()
      .should("have.css", "transform", "matrix(1, 0, 0, 1, 420, 400)");

    cy.wait(300);

    // Select card
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .click(500, 500, { force: true });

    cy.intercept(
      {
        method: "POST",
        url: "/airboardgame/store/session/*",
      },
      // eslint-disable-next-line quotes
      (req) => {
        expect(req.body).to.have.property("items");
        req.reply(req.body);
      }
    ).as("postSession");

    cy.wait(300);

    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .trigger("pointerdown", {
        buttons: 1,
        clientX: 430,
        clientY: 430,
        force: true,
        pointerId: 1,
      });

    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .trigger("pointermove", {
        buttons: 1,
        clientX: 530,
        clientY: 530,
        force: true,
        pointerId: 1,
      })
      .trigger("pointerup", {
        force: true,
        pointerId: 1,
      });

    cy.wait("@postSession");
  });
});
