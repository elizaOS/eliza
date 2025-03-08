import type { ASTQueueItem } from "../../types";

export interface FileDocsGroup {
	filePath: string;
	classes: ASTQueueItem[];
	methods: ASTQueueItem[];
	interfaces: ASTQueueItem[];
	types: ASTQueueItem[];
	functions: ASTQueueItem[];
}

export interface OrganizedDocs {
	classes: ASTQueueItem[];
	methods: ASTQueueItem[];
	interfaces: ASTQueueItem[];
	types: ASTQueueItem[];
	functions: ASTQueueItem[];
	variables: ASTQueueItem[];
}
