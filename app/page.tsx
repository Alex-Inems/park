import ParkView from "./park-view";

export default function Home() {
  return (
    <main className="fixed inset-0 bg-[#b7e3f7]">
      <h1 className="sr-only">The Hangout</h1>
      <ParkView />
    </main>
  );
}
