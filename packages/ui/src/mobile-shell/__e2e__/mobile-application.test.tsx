// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import type {LauncherBridge} from '@elizaos/capacitor-system/launcher';
import {createMobileShellLauncher,createMobileApplicationCatalog,ELIZA_MOBILE_PRODUCT,MobileApplication,MOBILE_SHELL_HOME,navigateMobileShell,type MobileShellNavigationAction} from '../index';
afterEach(cleanup);
const pages=[{id:'notes',pluginId:'notes',label:'Notes',path:'/notes'},{id:'maps',pluginId:'maps',label:'Maps',path:'/maps'},{id:'photos',pluginId:'photos',label:'Photos',path:'/photos'},{id:'plugin.new-view',agentViewId:'new-view',pluginId:'plugin',label:'New view',path:'/apps/new-view'}];
it('discovers new registrations for both product records without using order as a feature allowlist',()=>{
 let registrations=pages.slice(0,2);
 const products=[ELIZA_MOBILE_PRODUCT,{...ELIZA_MOBILE_PRODUCT,views:{...ELIZA_MOBILE_PRODUCT.views,order:['notes' as const]}}];
 const catalogs=products.map(product=>createMobileApplicationCatalog(product,()=>registrations));
 registrations=[...pages];
 for(const catalog of catalogs){expect(catalog.available().map(page=>page.id).sort()).toEqual(['maps','new-view','notes','photos']);expect(catalog.find('plugin.new-view')?.path).toBe('/apps/new-view');}
 expect(createMobileApplicationCatalog(ELIZA_MOBILE_PRODUCT,()=>registrations,{available:page=>page.id!=='photos'}).find('photos')).toBeUndefined();
});
it('keeps assistant and retained editor mounted while one host navigation owner handles apps, Home and drawer Back',async()=>{
 const catalog=createMobileApplicationCatalog(ELIZA_MOBILE_PRODUCT,()=>pages);
 const bridge:LauncherBridge={list:vi.fn(async()=>({apps:[]})),launch:vi.fn(async()=>{})};
 const saved={read:()=>['eliza:notes','eliza:maps'],write:vi.fn()};
 let navigate:(action:MobileShellNavigationAction)=>void=()=>{};let mounts=0;
 function Assistant(){const[draft,setDraft]=useState(()=>{mounts++;return ''});return <input aria-label="Assistant draft" value={draft} onChange={event=>setDraft(event.target.value)}/>;}
 function Host(){const[nav,setNav]=useState({...MOBILE_SHELL_HOME});navigate=action=>setNav(current=>navigateMobileShell(current,action));return <MobileApplication catalog={catalog} navigation={nav} navigate={navigate} bridge={bridge} appearance="light" favorites={saved} retainedViews={<textarea aria-label="Retained Notes draft" defaultValue="saved"/>} assistant={<Assistant/>} renderView={page=><h1>{page.label}</h1>}/>;}
 render(<Host/>);fireEvent.change(screen.getByLabelText('Assistant draft'),{target:{value:'unsent'}});fireEvent.change(screen.getByLabelText('Retained Notes draft'),{target:{value:'edited'}});
 fireEvent.click(screen.getByRole('button',{name:'Maps'}));expect(screen.getByRole('heading',{name:'Maps'})).toBeTruthy();
 expect(document.querySelector('[data-mobile-shell-home]')?.hasAttribute('inert')).toBe(true);
 await act(async()=>navigate({type:'home'}));fireEvent.click(screen.getByRole('button',{name:'All apps'}));expect(await screen.findByRole('dialog',{name:'All apps'})).toBeTruthy();
 fireEvent.keyDown(screen.getByRole('dialog',{name:'All apps'}),{key:'Escape'});expect(screen.queryByRole('dialog',{name:'All apps'})).toBeNull();expect((screen.getByLabelText('Assistant draft') as HTMLInputElement).value).toBe('unsent');expect((screen.getByLabelText('Retained Notes draft') as HTMLTextAreaElement).value).toBe('edited');expect(mounts).toBe(1);expect(bridge.launch).not.toHaveBeenCalled();
});

it('keeps current and previously migrated Wallet favorites as in-app routes', async () => {
 const wallet={id:'wallet',pluginId:'wallet',label:'Wallet',path:'/wallet'};
 const catalog=createMobileApplicationCatalog(ELIZA_MOBILE_PRODUCT,()=>[wallet]);
 expect(catalog.find('wallet')?.path).toBe('/wallet');
 expect(catalog.find('inventory')?.path).toBe('/wallet');
 const bridge:LauncherBridge={list:vi.fn(async()=>({apps:[]})),launch:vi.fn(async()=>{})};
 const open=vi.fn();
 for(const key of ['eliza:wallet','eliza:inventory']) {
  const shell=createMobileShellLauncher({registry:catalog,bridge,open,changed:()=>{},favorites:{read:()=>[key],write:vi.fn()}});
  shell.syncViews();
  expect(shell.homeEntries()).toMatchObject([{kind:'view',key:'eliza:wallet',view:{path:'/wallet'}}]);
  await shell.launcher.launch({packageName:'eliza:wallet',label:'Wallet'});
 }
 expect(open.mock.calls.map(([page])=>page.path)).toEqual(['/wallet','/wallet']);
 expect(bridge.launch).not.toHaveBeenCalled();
 const both=createMobileApplicationCatalog(ELIZA_MOBILE_PRODUCT,()=>[wallet,{...wallet,id:'inventory',path:'/inventory'}]);
 expect(both.find('wallet')?.path).toBe('/wallet');
 expect(both.find('inventory')?.path).toBe('/inventory');
});

it('respects the host null fallback for routed content outside the launcher catalog', () => {
 const catalog=createMobileApplicationCatalog(ELIZA_MOBILE_PRODUCT,()=>pages);
 const clicked=vi.fn(), unavailable=vi.fn(()=>null);
 const bridge:LauncherBridge={list:vi.fn(async()=>({apps:[]})),launch:vi.fn(async()=>{})};
 render(<MobileApplication catalog={catalog} navigation={{...MOBILE_SHELL_HOME,view:'experience'}} navigate={()=>{}} bridge={bridge} appearance="light" favorites={{read:()=>[],write:()=>{}}} retainedViews={<button onClick={clicked}>Review experience</button>} renderView={()=>null} renderUnavailable={unavailable} assistant={null}/>);
 expect(unavailable).toHaveBeenCalledWith('experience');
 expect(screen.queryByText('This app is unavailable.')).toBeNull();
 expect(document.querySelector('[data-mobile-application-view]')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Review experience'}));expect(clicked).toHaveBeenCalledOnce();
});

it('keeps the default unavailable notice when no host fallback is provided', () => {
 const catalog=createMobileApplicationCatalog(ELIZA_MOBILE_PRODUCT,()=>pages);
 const bridge:LauncherBridge={list:vi.fn(async()=>({apps:[]})),launch:vi.fn(async()=>{})};
 render(<MobileApplication catalog={catalog} navigation={{...MOBILE_SHELL_HOME,view:'missing'}} navigate={()=>{}} bridge={bridge} appearance="light" favorites={{read:()=>[],write:()=>{}}} renderView={()=>null} assistant={null}/>);
 expect(screen.getByRole('status').textContent).toBe('This app is unavailable.');
});
