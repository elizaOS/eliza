@source
Feature: The right version of Qt packages are installed
    We don't ship software which depends on Qt5.
    As a Tails developer, I want to ensure we don't ship Qt5.

    Scenario: No Qt5 package is installed
        Given I have the build manifest for the image under test
        Then no Qt5 package is installed

