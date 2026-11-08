// @vitest-environment jsdom
/** Real table/query-cache/client flow; local HTTP controls only completion. */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { CloudI18nProvider } from "../../../shell/CloudI18nProvider";
import { AppsTable } from "../../components/apps-table";
import { APPS_QUERY_KEY, type App } from "../apps";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

test("bulk deleting rows stay visible with pending status and disabled mutations until exact HTTP receipts complete", async () => {
  const apps = ["one", "two"].map(id => ({id, name:`App ${id}`, app_url:"https://example.invalid", is_active:true, total_users:0, total_requests:0, updated_at:"2026-11-08T00:00:00Z"}) as App);
  const queryClient = new QueryClient({defaultOptions:{queries:{retry:false}}});
  queryClient.setQueryData(APPS_QUERY_KEY,apps);
  let complete=false;
  const gates:Array<()=>void>=[];
  const calls:string[]=[];
  vi.stubGlobal("fetch", async (input:RequestInfo|URL, init?:RequestInit) => {
    const path=String(input);calls.push(`${init?.method ?? "GET"} ${path}`);
    const id=path.split("/").at(-1)!;
    if(init?.method==="DELETE")return Response.json({success:false,state:"pending",status:"pending",appId:id,jobId:`job-${id}`},{status:202});
    if(!complete)await new Promise<void>(resolve=>gates.push(resolve));
    return Response.json({success:true,data:{id,type:"app_delete",status:"completed",result:{appDeleted:true,appId:id.replace("job-",""),deletionJobId:id,cleanupConfirmed:true}}});
  });
  function Rows(){const {data=[]}=useQuery<App[]>({queryKey:APPS_QUERY_KEY,queryFn:async()=>apps,enabled:false});return <AppsTable apps={data}/>}
  render(<QueryClientProvider client={queryClient}><MemoryRouter><CloudI18nProvider initialLang="en"><Rows/></CloudI18nProvider></MemoryRouter></QueryClientProvider>);
  const user=userEvent.setup();
  await user.click(screen.getByRole("checkbox",{name:"Select App one"}));
  await user.click(screen.getByRole("checkbox",{name:"Select App two"}));
  await user.click(screen.getByRole("button",{name:"Delete selected"}));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button",{name:"Delete"}));
  await waitFor(()=>expect(screen.getAllByText("Deleting…")).toHaveLength(2));
  expect(screen.getByRole("checkbox",{name:"Select App one"}).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("checkbox",{name:"Select App two"}).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("link",{name:"App one"})).toBeNull();
  expect(screen.queryByRole("link",{name:"App two"})).toBeNull();
  expect(queryClient.getQueryData<App[]>(APPS_QUERY_KEY)).toHaveLength(2);
  await user.click(screen.getAllByRole("button",{name:"Open actions"})[0]!);
  expect(screen.getByRole("menuitem",{name:"Manage App"}).hasAttribute("data-disabled")).toBe(true);
  expect(screen.getByRole("menuitem",{name:"Delete App"}).hasAttribute("data-disabled")).toBe(true);
  expect(calls.filter(value=>value.startsWith("DELETE "))).toHaveLength(2);
  await act(async()=>{complete=true;for(const release of gates)release();});
  await waitFor(()=>expect(queryClient.getQueryData<App[]>(APPS_QUERY_KEY)).toHaveLength(0));
  expect(screen.queryByText("App one")).toBeNull();
  expect(screen.queryByText("App two")).toBeNull();
  expect(calls.filter(value=>value.startsWith("DELETE "))).toHaveLength(2);
  queryClient.clear();
});
