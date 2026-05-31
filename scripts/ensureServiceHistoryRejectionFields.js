const PocketBase = require("pocketbase/cjs");
require("dotenv").config();

function textField(name) {
  return {
    name,
    type: "text",
    required: false,
    min: 0,
    max: 0,
    pattern: "",
    autogeneratePattern: "",
  };
}

function dateField(name) {
  return {
    name,
    type: "date",
    required: false,
    min: "",
    max: "",
  };
}

async function main() {
  const host = process.env.PB_HOST;
  const email = process.env.PB_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASS;

  if (!host || !email || !password) {
    throw new Error("PB_HOST, PB_ADMIN_EMAIL, and PB_ADMIN_PASS are required.");
  }

  const pb = new PocketBase(host);
  pb.autoCancellation(false);

  await pb.collection("_superusers").authWithPassword(email, password);

  const wanted = [
    textField("rejected_by"),
    textField("rejected_reason"),
    dateField("rejected_date"),
  ];

  const collection = await pb.collections.getOne("service_history");
  const existingNames = new Set(
    (collection.fields || []).map((field) => field.name),
  );
  const missing = wanted.filter((field) => !existingNames.has(field.name));

  if (!missing.length) {
    console.log(
      `service_history already has rejection fields on ${host.replace(/\/+$/, "")}`,
    );
    return;
  }

  await pb.collections.update(collection.id, {
    fields: [...(collection.fields || []), ...missing],
  });

  console.log(
    `Added fields to service_history on ${host.replace(/\/+$/, "")}: ${missing
      .map((field) => field.name)
      .join(", ")}`,
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
