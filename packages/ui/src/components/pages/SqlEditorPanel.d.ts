import type { QueryResult } from "../../api";
export declare function SqlEditorPanel({ queryText, setQueryText, queryResult, queryLoading, runQuery, queryHistory, showHistory, onCellClick, }: {
    queryText: string;
    setQueryText: (text: string) => void;
    queryResult: QueryResult | null;
    queryLoading: boolean;
    runQuery: () => void;
    queryHistory: string[];
    /** Show inline query history (used when there is no sidebar to display it). */
    showHistory: boolean;
    onCellClick: (value: string) => void;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=SqlEditorPanel.d.ts.map