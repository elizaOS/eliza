const outside = { border: "1px solid #fff", title: "Order #1042" }
export const Bad = () => (
  <div className="bg-red-500" style={outside}>
    <p className="text-[#fff]">a</p>
    <p style={{ color: "#fff" }}>b</p>
    {/* eslint-disable-next-line design-system/no-literal-colors */}
    <p style={{ color: "#000" }}>c</p>
    <p className="bg-white">d</p>
    <p className="text-black">e</p>
    <p className="bg-red-500!">f</p>
    <p className="!bg-red-500">g</p>
    <p className="bg-[red]">h</p>
    <p className="text-[color:rebeccapurple]">i</p>
    <p className="shadow-xl">j</p>
    <p className="shadow-2xl">k</p>
    <p className="rounded-2xl">l</p>
    <p className="font-serif">m</p>
    <p style={{ color: "red" }}>n</p>
    <p style={{ background: "color-mix(in oklch, var(--primary), var(--card))" }}>o</p>
  </div>
)
