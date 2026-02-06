describe("Homepage", () => {
  beforeEach(() => {
    cy.intercept(
      {
        method: "GET",
        url: "/airboardgame/store/game*",
      },
      "[]"
    );
    cy.visit("/");
  });

  it("should show all available games by default", () => {
    cy.contains("0 Test game").should("be.visible");
    cy.contains("1 Performance game to test strange things and other").should(
      "be.visible"
    );
  });

  it("should show both default games if searching for 'test' string", () => {
    cy.get('input[name="game-search"').type("test");
    cy.contains("0 Test game").should("be.visible");
    cy.contains("1 Performance game to test strange things and other").should(
      "be.visible"
    );
  });

  it("should show only game 1 if searching for 'Performance' string", () => {
    cy.get('input[name="game-search"').type("Performance");
    cy.contains("0 Test game").should("not.exist");
    cy.contains("1 Performance game to test strange things and other").should(
      "be.visible"
    );
  });

  it("should not show any game for 'thisisafancystring' string", () => {
    cy.get('input[name="game-search"').type("thisisafancystring");
    cy.contains("0 Test game").should("not.exist");
    cy.contains("1 Performance game to test strange things and other").should(
      "not.exist"
    );
  });

  it("should not show unpublished game by default", () => {
    cy.contains("2 Unpublished game").should("not.exist");
  });

  it("should only show the Perf game (1-9+ playerds) and not the Test game (2-4 players) when selecting 5-9 players range", () => {
    // WARNING: this test is very fragile
    // By clicking on .rc-slider, it will put the slider min value at the middle of the interval (5 for a 1-9 interval),
    // which is what we need for this test.
    // Be aware that, if the total range of the slide decreases (1-5) for example, clicking on it will trigger a min value of
    // 3 (instead of the current 5), and this test will fail, as "0 Test game" will now appear.
    // I didn't find any better way yet, as there is no pre-defined markup to be able to precisely select a given step of the slider.
    cy.get(".rc-slider:first").click();
    cy.contains("0 Test game").should("not.exist");
    cy.contains("1 Performance game to test strange things and other").should(
      "be.visible"
    );
  });
});
