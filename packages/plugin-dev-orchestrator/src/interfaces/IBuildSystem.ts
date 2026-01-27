export interface BuildResult {
    success: boolean;
    output: string;
    error?: string;
    exitCode: number;
}

export interface IBuildSystem {
    /**
     * Detect the build system for a project
     */
    detect(projectPath: string): Promise<string | null>;

    /**
     * Run the build command
     */
    build(projectPath: string, buildCmd?: string): Promise<BuildResult>;

    /**
     * Run tests
     */
    test(projectPath: string, testCmd?: string): Promise<BuildResult>;
}

