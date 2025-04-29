import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from './ui/input';
import { Check, Eye, EyeOff, MoreVertical, X } from 'lucide-react';
import { Button } from './ui/button';
import { apiClient } from '@/lib/api';

enum EnvType {
  GLOBAL = 'global',
  LOCAL = 'local',
}

export default function EnvSettings() {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedValue, setEditedValue] = useState('');
  const [globalEnvs, setGlobalEnvs] = useState<Record<string, string>>({});
  const [localEnvs, setLocalEnvs] = useState<Record<string, string>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState(EnvType.GLOBAL);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenIndex(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    fetchGlobalEnvs();
    fetchLocalEnvs();
  }, []);

  const fetchGlobalEnvs = async () => {
    const data = await apiClient.getGlobalEnvs();
    setGlobalEnvs(data.data);
  };

  const fetchLocalEnvs = async () => {
    const data = await apiClient.getLocalEnvs();
    setLocalEnvs(data.data);
  };

  const handleReset = async () => {
    if (activeTab === EnvType.GLOBAL) {
      await fetchGlobalEnvs();
    } else if (activeTab === EnvType.LOCAL) {
      await fetchLocalEnvs();
    }
    // No other EnvType values exist as per the enum definition

    setEditingIndex(null);
    setOpenIndex(null);
    setName('');
    setValue('');
  };

  const ENV_TABS_SCHEMA = [
    {
      sectionTitle: 'Global Env',
      sectionValue: EnvType.GLOBAL,
      data: globalEnvs,
    },
    {
      sectionTitle: 'Local Env',
      sectionValue: EnvType.LOCAL,
      data: localEnvs,
    },
  ];

  const handleEdit = (key: string) => {
    setEditingIndex(openIndex);
    const envs = activeTab === EnvType.GLOBAL ? globalEnvs : localEnvs;
    setEditedValue(envs[key]);
    setOpenIndex(null);
  };

  const handleRemove = (key: string) => {
    const updateFn = activeTab === EnvType.GLOBAL ? setGlobalEnvs : setLocalEnvs;
    const prevData = activeTab === EnvType.GLOBAL ? globalEnvs : localEnvs;

    const updatedData = { ...prevData };
    delete updatedData[key];

    updateFn(updatedData);
    setOpenIndex(null);
  };

  const saveEdit = (key: string) => {
    const updateFn = activeTab === EnvType.GLOBAL ? setGlobalEnvs : setLocalEnvs;
    const prevData = activeTab === EnvType.GLOBAL ? globalEnvs : localEnvs;

    updateFn({
      ...prevData,
      [key]: editedValue,
    });

    setEditingIndex(null);
  };

  const addEnv = () => {
    if (!name || !value) return;

    const updateFn = activeTab === EnvType.GLOBAL ? setGlobalEnvs : setLocalEnvs;
    const prevData = activeTab === EnvType.GLOBAL ? globalEnvs : localEnvs;

    updateFn({
      ...prevData,
      [name]: value,
    });

    setName('');
    setValue('');
    setEditingIndex(null);
  };

  return (
    <div className="container max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Envs settings</h1>
          <p className="text-muted-foreground mt-1">Envs settings</p>
        </div>
      </div>

      <Tabs
        defaultValue="global"
        className="w-full"
        value={activeTab}
        onValueChange={(val: any) => {
          setActiveTab(val);
          setEditingIndex(null);
        }}
      >
        <TabsList
          className="grid w-full mb-6"
          style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
        >
          {ENV_TABS_SCHEMA.map((section) => (
            <TabsTrigger key={section.sectionValue} value={section.sectionValue}>
              {section.sectionTitle}
            </TabsTrigger>
          ))}
        </TabsList>

        <Card>
          <CardContent className="p-6">
            {ENV_TABS_SCHEMA.map((section) => (
              <TabsContent
                key={section.sectionValue}
                value={section.sectionValue}
                className="space-y-6"
              >
                <div className="rounded-lg w-full flex flex-col gap-3">
                  <h2 className="text-xl font-bold mb-4 pb-5 ml-1">Environment Settings</h2>
                  <div className="grid grid-cols-[1fr_2fr_auto] gap-4 items-end w-full pb-4">
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="secret-name"
                        className="ml-2 text-xs font-medium text-gray-400"
                      >
                        NAME
                      </label>
                      <Input
                        id="secret-name"
                        placeholder="VARIABLE_NAME"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1 relative">
                      <label
                        htmlFor="secret-value"
                        className="ml-2 text-xs font-medium text-gray-400"
                      >
                        VALUE
                      </label>
                      <div className="relative">
                        <Input
                          id="secret-value"
                          type={showPassword ? 'text' : 'password'}
                          placeholder="i9ju23nfsdf56"
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          className="pr-10"
                        />
                        <div
                          className="absolute inset-y-0 right-3 flex items-center cursor-pointer text-gray-500"
                          onClick={() => setShowPassword(!showPassword)}
                        >
                          {showPassword ? <EyeOff /> : <Eye />}
                        </div>
                      </div>
                    </div>
                    <Button className="shrink-0" onClick={addEnv}>
                      Add
                    </Button>
                  </div>

                  {section?.data && (
                    <div className="grid grid-cols-[1fr_2fr_auto] gap-4 mt-6 font-medium text-gray-400 border-b pb-2 ml-1">
                      <div>Name</div>
                      <div>Value</div>
                      <div>Action</div>
                    </div>
                  )}

                  <div className="mt-2">
                    {section?.data &&
                      Object.entries(section.data).map(([key, value], index) => (
                        <div
                          key={index}
                          className="grid grid-cols-[1fr_2fr_auto] gap-4 items-center border-b py-2 ml-1 relative"
                        >
                          <div className="truncate max-w-48">{key}</div>
                          <div>
                            {editingIndex === index ? (
                              <div className="flex items-center gap-2">
                                <Input
                                  value={editedValue}
                                  onChange={(e) => setEditedValue(e.target.value)}
                                  className="w-full"
                                />
                                <Button variant="ghost" onClick={() => saveEdit(key)}>
                                  <Check className="w-5 h-5 text-green-500" />
                                </Button>
                                <Button variant="ghost" onClick={() => setEditingIndex(null)}>
                                  <X className="w-5 h-5 text-red-500" />
                                </Button>
                              </div>
                            ) : (
                              <div className="truncate text-gray-500">Encrypted</div>
                            )}
                          </div>
                          <div className="relative">
                            <Button
                              variant="ghost"
                              className="p-2 text-gray-500"
                              onClick={() => setOpenIndex(openIndex === index ? null : index)}
                            >
                              <MoreVertical className="h-5 w-5" />
                            </Button>
                            {openIndex === index && (
                              <div
                                ref={dropdownRef}
                                className="absolute right-0 mt-2 w-56 rounded-md shadow-lg bg-card ring-1 ring-black ring-opacity-5 z-10"
                              >
                                <div className="py-1">
                                  <button
                                    onClick={() => handleEdit(key)}
                                    className="w-full text-left px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => handleRemove(key)}
                                    className="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-accent"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>

                <div className="flex gap-2 mt-3 justify-end">
                  <Button variant="outline" onClick={handleReset}>
                    Reset
                  </Button>
                  <Button variant="outline" disabled={isUpdating}>
                    Save Changes
                  </Button>
                </div>
              </TabsContent>
            ))}
          </CardContent>
        </Card>
      </Tabs>
    </div>
  );
}
