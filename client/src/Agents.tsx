import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { useGetAgentsQuery } from "@/api";
import "./App.css";

function Agents() {
    const navigate = useNavigate();
    const { data: agents, isLoading } = useGetAgentsQuery()

    return (
        <div className="min-h-screen flex flex-col items-center justify-center p-4">
            <h1 className="text-2xl font-bold mb-8">Select your agent:</h1>

            {isLoading ? (
                <div>Loading agents...</div>
            ) : (
                <div className="grid gap-4 w-full max-w-md">
                    {agents?.map((agent) => (
                        <Button
                            key={agent.id}
                            className="w-full text-lg py-6"
                            onClick={() => {
                                navigate(`/${agent.id}`);
                            }}
                        >
                            {agent.name}
                        </Button>
                    ))}
                </div>
            )}
        </div>
    );
}

export default Agents;
