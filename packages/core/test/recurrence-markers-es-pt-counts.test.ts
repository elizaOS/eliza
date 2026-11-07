import { expect, it } from "vitest";
import { textStatesExplicitRecurrence } from "../src/i18n/recurrence-markers";

// English already accepts a count ("every two weeks", "3 times a day").
it.each([
	["Agenda la revisión del equipo el lunes a las 10, cada dos semanas", true],
	["recuérdame tomar la pastilla cada 8 horas", true],
	["toma la vitamina dos veces al día", true],
	["Marque a reunião de equipe na segunda às 10, a cada duas semanas", true],
	["me lembre de beber água a cada hora", true],
	["academia três vezes por semana", true],
	["recuérdame en dos semanas revisar el contrato", false],
	["lo llamé tres veces hoy", false],
	["me lembre daqui a duas semanas de renovar o contrato", false],
	["liguei três vezes hoje", false],
] as const)("reads a Spanish or Portuguese count in %j", (text, recurring) => {
	expect(textStatesExplicitRecurrence(text)).toBe(recurring);
});
